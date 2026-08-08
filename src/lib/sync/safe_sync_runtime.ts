import { normalizePath, TFile, TFolder } from "obsidian"

import type FastSync from "../../main"
import { SafeSyncEngine, SafeSyncClientStatus, SafeSyncEvent, SafeSyncManifestMismatchError, SafeMutationInput } from "./safe_sync_engine"
import { SafeSyncWebSocketTransport } from "./safe_sync_websocket_transport"
import { SafeSyncStateStore, createSafeSyncNamespace } from "../storage/safe_sync_state_store"
import { generateUUID, getPluginDir, hashContentAsync, hashFileAsync, isFolderSyncPathExcluded, isPathExcluded, vaultDelete } from "../utils/helpers"
import { SafeRemoteDeleteProtector, SafeRemoteDeleteResult } from "./safe_remote_delete_protector"
import { receiveSafeDirectEvent } from "./safe_sync_inbound"
import { applySyncRoleSettingConflicts, type SyncRole } from "./safe_sync_role"
import { safeSyncTextSize } from "./safe_sync_content"

export type SafeSyncWriteMode = "legacy" | "safe" | "paused"
export type { SyncRole } from "./safe_sync_role"

export class SafeSyncRuntime {
  readonly transport: SafeSyncWebSocketTransport
  readonly engine: SafeSyncEngine
  private drainingDirectEvents = false
  private roleHeartbeat?: number

  constructor(private readonly plugin: FastSync) {
    this.transport = new SafeSyncWebSocketTransport({
      requestId: generateUUID,
      send: async (action, payload, context) => {
        if (!plugin.websocket.isConnected()) throw new Error("safe sync websocket is not connected")
        await plugin.websocket.SendMessage(action, payload, undefined, undefined, context)
      },
    })
    this.engine = new SafeSyncEngine({
      vault: plugin.settings.vault,
      serverUrl: plugin.runApi || plugin.settings.api,
      transport: this.transport,
      createStateStore: ({ serverFingerprint, uid, vaultId }) => new SafeSyncStateStore(
        plugin,
        createSafeSyncNamespace(serverFingerprint, uid, vaultId),
        generateUUID(),
      ),
      getLocalManifest: () => this.getLocalManifest(),
      operationId: generateUUID,
      now: Date.now,
    })
  }

  get status(): SafeSyncClientStatus {
    return this.engine.status
  }

  async onConnected(): Promise<SafeSyncClientStatus> {
    let status: SafeSyncClientStatus
    try {
      status = this.plugin.settings.safeRevisionSyncEnabled
        ? await this.engine.activate()
        : await this.engine.refreshStatus(false)
    } catch {
      status = this.engine.status
    }
    if (this.plugin.settings.safeRevisionSyncEnabled && status.state !== "active" && status.state !== "bootstrapping") {
      this.plugin.settings.safeRevisionSyncEnabled = false
      await this.plugin.saveSettings()
      if (status.serverState === "STRICT") await this.engine.refreshStatus(false)
      status = this.engine.status
    }
    if (status.capability && this.engine.store) {
      try {
        await this.registerDeviceRole(this.plugin.settings.syncRole)
      } catch (error) {
        status = { ...status, message: error instanceof Error ? error.message : String(error) }
      }
    }
    if (applySyncRoleSettingConflicts(this.plugin.settings, this.plugin.settings.syncRole)) {
      await this.plugin.saveSettings()
    }
    this.plugin.settingTab?.refresh()
    return status
  }

  async setDeviceRole(role: SyncRole): Promise<void> {
    await this.registerDeviceRole(role)
    this.plugin.settings.syncRole = role
    applySyncRoleSettingConflicts(this.plugin.settings, role)
    await this.plugin.saveSettings()
  }

  async registerDeviceRole(role: SyncRole): Promise<Record<string, unknown>> {
    const store = this.engine.store
    if (!store) throw new Error("safe sync device identity is unavailable")
    const response = await this.transport.request("DeviceRoleRegister", {
      vault: this.plugin.settings.vault,
      deviceId: store.deviceId,
      role: role === "local-publisher" ? "LOCAL_PUBLISHER" : role === "remote-mirror" ? "REMOTE_MIRROR" : "BIDIRECTIONAL",
    })
    this.startRoleHeartbeat()
    return response
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    if (!enabled) {
      this.plugin.settings.safeRevisionSyncEnabled = false
      await this.plugin.saveSettings()
      await this.engine.refreshStatus(false)
      this.plugin.settingTab?.refresh()
      return true
    }
    if (!this.plugin.websocket.isConnected()) return false
    const status = await this.engine.activate()
    const activated = status.state === "active"
    this.plugin.settings.safeRevisionSyncEnabled = activated
    await this.plugin.saveSettings()
    this.plugin.settingTab?.refresh()
    return activated
  }

  writeMode(): SafeSyncWriteMode {
    if (this.plugin.settings.safeRevisionSyncEnabled) {
      return this.status.state === "active" ? "safe" : "paused"
    }
    return this.status.serverState === "STRICT" || this.status.serverState === "BOOTSTRAPPING" ? "paused" : "legacy"
  }

  receive(action: string, payload: unknown): boolean {
    return this.transport.receive(action, payload)
  }

  mutateNote(input: SafeMutationInput) {
    return this.engine.mutate("NOTE", input.content === undefined ? input : { ...input, size: safeSyncTextSize(input.content) })
  }

  mutateFolder(input: SafeMutationInput) {
    return this.engine.mutate("FOLDER", input)
  }

  mutateFile(input: SafeMutationInput) {
    return this.engine.mutate("FILE", input)
  }

  startFileUpload(input: SafeMutationInput, chunkSize: number) {
    return this.engine.startFileUpload(input, chunkSize)
  }

  commitFileUpload(operationId: string, sessionId: string, contentHash: string, size: number) {
    return this.engine.commitFileUpload(operationId, sessionId, contentHash, size)
  }

  async prepareRemoteEvents(): Promise<number> {
    const count = await this.engine.prepareRemoteEvents()
    await this.drainDirectRemoteEvents()
    return count
  }

  claimRemoteEvent(
    resourceType: SafeSyncEvent["resourceType"],
    action: "UPSERT" | "DELETE" | "RENAME",
    path: string,
    previousPath: string = "",
    contentHash: string = "",
  ): Promise<SafeSyncEvent | undefined> {
    const mode = this.writeMode()
    if (mode === "legacy") return Promise.resolve(undefined)
    if (mode === "paused") return Promise.reject(new Error("safe revision sync is paused"))
    return this.engine.claimRemoteEvent(resourceType, action, path, previousPath, contentHash)
  }

  verifyRemoteEvent(
    event: SafeSyncEvent,
    sourceContentHash: string | null,
    targetContentHash: string | null = null,
  ): boolean {
    const sourcePath = event.action === "RENAME" ? event.previousPath || "" : event.path
    const baseline = this.engine.store?.getBaseline(sourcePath)
    if (event.action === "CREATE") {
      if (sourceContentHash == null) return true
      if (sourceContentHash === event.contentHash) return false
      throw new Error(`safe sync create target differs from the server event at ${event.path}`)
    }
    if (!baseline) throw new Error(`safe sync remote event has no baseline at ${sourcePath}`)
    if (event.action === "RENAME") {
      if (sourceContentHash == null && targetContentHash === event.contentHash) return false
      if (sourceContentHash === baseline.contentHash && targetContentHash == null) return true
      throw new Error(`safe sync rename precondition failed at ${sourcePath}`)
    }
    if (sourceContentHash === event.contentHash) return false
    if (sourceContentHash === baseline.contentHash) return true
    throw new Error(`safe sync remote content differs from the confirmed baseline at ${sourcePath}`)
  }

  async commitRemoteEvent(event: SafeSyncEvent, contentHash: string, size: number): Promise<void> {
    await this.engine.commitRemoteEvent(event, {
      path: event.path,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      resourceRevision: event.resourceRevision,
      contentHash,
      vaultRevision: event.vaultRevision,
      state: event.action === "DELETE" ? "DELETED" : "LIVE",
      size,
    })
    if (!this.drainingDirectEvents) await this.drainDirectRemoteEvents()
  }

  rejectRemoteEvent(event: SafeSyncEvent, reason: unknown): void {
    this.engine.rejectRemoteEvent(event, reason)
  }

  abortRemoteEvents(reason: unknown): void {
    this.engine.cancelRemoteEvents(reason)
  }

  async protectRemoteDelete(event: SafeSyncEvent, currentContentHash: string): Promise<SafeRemoteDeleteResult> {
    const store = this.engine.store
    if (!store) throw new Error("safe sync state store is not initialized")
    const vault = this.plugin.app.vault
    const adapter = vault.adapter
    const protector = new SafeRemoteDeleteProtector({
      exists: (path) => adapter.exists(normalizePath(path)),
      readBinary: (path) => adapter.readBinary(normalizePath(path)),
      writeBinary: (path, data) => adapter.writeBinary(normalizePath(path), data),
      remove: async (path) => {
        const file = vault.getAbstractFileByPath(normalizePath(path))
        if (file) await vaultDelete(vault, file, true)
      },
      mkdir: (path) => adapter.mkdir(normalizePath(path)),
    }, store, `${getPluginDir(this.plugin)}/recovery/safe-sync`, Date.now, (baseline) => this.engine.commitRemoteEvent(event, baseline))
    const result = await protector.apply(event, currentContentHash)
    if (result.outcome === "conflict") {
      const error = new Error(`safe sync remote delete was blocked: ${result.reason}`)
      this.engine.rejectRemoteEvent(event, error)
      throw error
    }
    return result
  }

  hasLiveBaseline(path: string): boolean {
    return this.engine.store?.getBaseline(path)?.state === "LIVE"
  }

  baselineAt(path: string) {
    return this.engine.store?.getBaseline(path)
  }

  discardPendingForPaths(paths: string[]): Promise<number> {
    return this.engine.discardPendingForPaths(paths)
  }

  close(): void {
    if (this.roleHeartbeat) window.clearInterval(this.roleHeartbeat)
    this.engine.cancelRemoteEvents(new Error("safe sync runtime closed"))
    this.transport.close()
  }

  onDisconnected(): void {
    this.engine.cancelRemoteEvents(new Error("safe sync websocket disconnected"))
    this.transport.close("safe sync websocket disconnected")
  }

  private async getLocalManifest() {
    const manifest: Array<{ resourceType: "NOTE" | "FILE" | "FOLDER"; path: string; contentHash: string; size: number }> = []
    for (const entry of this.plugin.app.vault.getAllLoadedFiles()) {
      if (!entry.path || entry.path === "/") continue
      if (entry instanceof TFolder) {
        if (!isFolderSyncPathExcluded(entry.path, this.plugin)) {
          manifest.push({ resourceType: "FOLDER", path: entry.path, contentHash: "", size: 0 })
        }
        continue
      }
      if (!(entry instanceof TFile) || isPathExcluded(entry.path, this.plugin)) continue
      const isNote = entry.path.endsWith(".md")
      const content = isNote ? await this.plugin.app.vault.read(entry) : undefined
      const contentHash = content === undefined
        ? await hashFileAsync(this.plugin.app, entry.path)
        : await hashContentAsync(content)
      manifest.push({
        resourceType: isNote ? "NOTE" : "FILE",
        path: entry.path,
        contentHash,
        size: content === undefined ? entry.stat.size : safeSyncTextSize(content),
      })
    }
    return manifest
  }

  private async drainDirectRemoteEvents(): Promise<void> {
    if (this.drainingDirectEvents) return
    this.drainingDirectEvents = true
    try {
      while (true) {
        const event = this.engine.nextRemoteEvent()
        if (!event || (event.action !== "DELETE" && event.action !== "RENAME")) return
        await receiveSafeDirectEvent(event, this.plugin)
      }
    } finally {
      this.drainingDirectEvents = false
    }
  }

  private startRoleHeartbeat(): void {
    if (this.roleHeartbeat) window.clearInterval(this.roleHeartbeat)
    this.roleHeartbeat = window.setInterval(() => {
      if (this.plugin.websocket.isConnected()) void this.registerDeviceRole(this.plugin.settings.syncRole).catch(() => undefined)
    }, 60_000)
  }
}

export function safeSyncActivationErrorMessage(error: unknown): string {
  if (error instanceof SafeSyncManifestMismatchError) {
    return `发现 ${error.mismatches.length} 个本地与服务端不一致的项目，已取消激活。`
  }
  return error instanceof Error ? error.message : String(error)
}
