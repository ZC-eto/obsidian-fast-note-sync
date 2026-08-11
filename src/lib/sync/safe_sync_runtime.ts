import { normalizePath, TFile, TFolder } from "obsidian"

import type FastSync from "../../main"
import { SafeSyncEngine, SafeSyncClientStatus, SafeSyncEvent, SafeSyncManifestMismatchError, SafeMutationInput } from "./safe_sync_engine"
import { SafeSyncTransportError, SafeSyncWebSocketTransport } from "./safe_sync_websocket_transport"
import { SafeSyncStateStore, createSafeSyncNamespace, type SafePendingMutation } from "../storage/safe_sync_state_store"
import { generateUUID, getPluginDir, getSafeCtime, hashContent, hashContentAsync, hashFileAsync, isFolderSyncPathExcluded, isPathExcluded, vaultDelete } from "../utils/helpers"
import { SafeRemoteDeleteProtector, SafeRemoteDeleteResult } from "./safe_remote_delete_protector"
import { receiveSafeDirectEvent } from "./safe_sync_inbound"
import { applySyncRoleSettingConflicts, type SyncRole } from "./safe_sync_role"
import { safeSyncTextSize } from "./safe_sync_content"
import { planSafeLocalChanges, SafeLocalChange } from "./safe_sync_reconciler"
import { receiveFileUpload } from "./operator_file"
import { FileCloudPreview } from "../storage/file_cloud_preview"

export type SafeSyncWriteMode = "legacy" | "safe" | "paused"
export type { SyncRole } from "./safe_sync_role"

export class SafeSyncRuntime {
  readonly transport: SafeSyncWebSocketTransport
  readonly engine: SafeSyncEngine
  private drainingDirectEvents = false
  private roleHeartbeat?: number
  private remoteRefreshTimer?: number

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
    if (this.plugin.safeMirrorManager?.isBusy) return "paused"
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

  async prepareStartupSync(): Promise<number> {
    if (!this.plugin.settings.safeRevisionSyncEnabled || this.plugin.safeMirrorManager?.isBusy) return 0
    try {
      if (this.engine.status.state !== "active") {
        const status = await this.engine.refreshStatus(true)
        if (status.state !== "active") throw new Error(status.message || `safe sync is ${status.state}`)
      }
      const localItems = await this.engine.localManifest()
      const recovered = await this.recoverPendingMutations(localItems)
      await this.prepareRemoteEvents()
      if (this.plugin.settings.readonlySyncEnabled) return 0
      const store = this.engine.store
      if (!store) throw new Error("safe sync state store is not initialized")
      const changes = planSafeLocalChanges(localItems, this.reconciliationBaselines(localItems), this.engine.pendingRemoteEvents())
      for (const change of changes) await this.applyLocalChange(change, localItems)
      if (changes.length > 0) await this.prepareRemoteEvents()
      return recovered + changes.length
    } catch (error) {
      this.engine.failClosed(error)
      this.plugin.settingTab?.refresh()
      throw error
    }
  }

  hasRetryablePending(): boolean {
    return Boolean(this.engine.store && this.engine.retryablePending().length > 0)
  }

  queueRemoteRefresh(delayMs: number = 0): void {
    if (this.remoteRefreshTimer) return
    const attempt = () => {
      if (!this.plugin.websocket.isConnected()) {
        this.remoteRefreshTimer = undefined
        return
      }
      if (this.plugin.isSyncing || this.plugin.isSyncRequesting || this.plugin.safeMirrorManager?.isBusy) {
        this.remoteRefreshTimer = window.setTimeout(attempt, 250)
        return
      }
      this.remoteRefreshTimer = undefined
      void this.plugin.websocket.StartHandle()
    }
    this.remoteRefreshTimer = window.setTimeout(attempt, delayMs)
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
    if (this.remoteRefreshTimer) window.clearTimeout(this.remoteRefreshTimer)
    this.engine.cancelRemoteEvents(new Error("safe sync runtime closed"))
    this.transport.close()
  }

  onDisconnected(): void {
    if (this.remoteRefreshTimer) window.clearTimeout(this.remoteRefreshTimer)
    this.remoteRefreshTimer = undefined
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

  private async recoverPendingMutations(
    localItems: Array<{ resourceType: "NOTE" | "FILE" | "FOLDER"; path: string; contentHash: string; size: number }>,
  ): Promise<number> {
    const initial = this.engine.retryablePending()
    if (initial.length === 0) return 0

    const events = await this.engine.pullEvents()
    await this.engine.acknowledgePendingEvents(events)
    let recovered = 0
    const remainingIds = new Set(this.engine.retryablePending().map((pending) => pending.operationId))
    for (const pending of initial) {
      if (remainingIds.has(pending.operationId)) continue
      this.updateRecoveredPendingCaches(pending, localItems)
      recovered++
    }

    const remaining = this.engine.retryablePending()
    if (remaining.length > 0 && this.plugin.settings.readonlySyncEnabled) {
      throw new Error(`safe sync has ${remaining.length} pending local operation(s), but this device is read-only`)
    }
    for (const pending of remaining) {
      const resourceType = this.resolvePendingResourceType(pending, localItems)
      try {
        if (resourceType === "FILE" && (pending.payload.action === "CREATE" || pending.payload.action === "MODIFY")) {
          await this.retryPendingFileUpload(pending)
        } else {
          await this.engine.retryPendingMutation(resourceType, pending)
        }
      } catch (error) {
        if (error instanceof SafeSyncTransportError && error.errorCode === "PATH_STATE_CONFLICT" && pending.payload.action === "CREATE") {
          await this.recoverExistingCreateConflict(pending, resourceType, localItems)
          recovered++
          continue
        }
        throw error
      }
      this.updateRecoveredPendingCaches(pending, localItems)
      recovered++
    }
    return recovered
  }

  private resolvePendingResourceType(
    pending: SafePendingMutation,
    localItems: Array<{ resourceType: "NOTE" | "FILE" | "FOLDER"; path: string }>,
  ): "NOTE" | "FILE" | "FOLDER" {
    if (pending.resourceType) return pending.resourceType
    const baselinePath = pending.previousPath || pending.path
    const baseline = this.engine.store?.getBaseline(baselinePath)
    if (baseline?.resourceType) return baseline.resourceType
    const local = localItems.find((item) => item.path === pending.path || item.path === pending.previousPath)
    if (local) return local.resourceType
    if (pending.path.toLowerCase().endsWith(".md")) return "NOTE"
    throw new Error(`safe sync cannot determine the resource type for pending operation ${pending.operationId}`)
  }

  private async retryPendingFileUpload(pending: SafePendingMutation): Promise<void> {
    const file = this.plugin.app.vault.getFileByPath(normalizePath(pending.path))
    if (!(file instanceof TFile)) throw new Error(`safe sync pending file is missing locally: ${pending.path}`)
    const contentHash = await hashFileAsync(this.plugin.app, file.path)
    const expectedHash = typeof pending.payload.contentHash === "string" ? pending.payload.contentHash : ""
    const expectedSize = Number(pending.payload.size)
    if (!expectedHash || contentHash !== expectedHash || !Number.isSafeInteger(expectedSize) || file.stat.size !== expectedSize) {
      throw new Error(`safe sync pending file changed before upload recovery: ${pending.path}`)
    }

    const chunkSize = 1024 * 1024
    const upload = await this.engine.retryPendingFileUploadStart(pending, chunkSize)
    await receiveFileUpload({
      path: pending.path,
      pathHash: hashContent(pending.path),
      ctime: pendingNumber(pending.payload.ctime, getSafeCtime(file.stat)),
      mtime: pendingNumber(pending.payload.mtime, file.stat.mtime),
      sessionId: upload.sessionId,
      chunkSize,
      nextChunkIndex: upload.nextChunkIndex,
      expectedContentHash: contentHash,
      awaitCompletion: true,
      onUploadReady: () => this.engine.commitFileUpload(upload.operationId, upload.sessionId, contentHash, file.stat.size).then(() => undefined),
    }, this.plugin)
  }

  private async recoverExistingCreateConflict(
    pending: SafePendingMutation,
    resourceType: "NOTE" | "FILE" | "FOLDER",
    localItems: Array<{ resourceType: "NOTE" | "FILE" | "FOLDER"; path: string; contentHash: string; size: number }>,
  ): Promise<void> {
    const snapshot = await this.engine.beginMirrorBootstrap()
    let committed = false
    try {
      const mismatches = this.engine.mirrorSnapshotMismatches(localItems, snapshot)
      if (mismatches.length > 0) {
        throw new Error(`safe sync cannot recover an existing create target while ${mismatches.length} manifest difference(s) remain`)
      }
      const remote = snapshot.remoteItems.find((item) => item.path === pending.path)
      const local = localItems.find((item) => item.path === pending.path)
      if (!remote || remote.state !== "LIVE" || remote.resourceType !== resourceType || !local ||
        remote.contentHash !== local.contentHash || remote.size !== local.size) {
        throw new Error(`safe sync existing create target does not match the local manifest: ${pending.path}`)
      }

      await this.engine.commitMirrorBootstrap(snapshot)
      committed = true
      await this.engine.discardPendingForPaths([pending.path])
      await this.applyLocalChange({
        action: "MODIFY",
        resourceType,
        path: pending.path,
        contentHash: local.contentHash,
        size: local.size,
      }, localItems)
    } catch (error) {
      if (!committed) await this.engine.cancelMirrorBootstrap().catch(() => undefined)
      throw error
    }
  }

  private updateRecoveredPendingCaches(
    pending: SafePendingMutation,
    localItems: Array<{ resourceType: "NOTE" | "FILE" | "FOLDER"; path: string; contentHash: string; size: number }>,
  ): void {
    const action = pending.payload.action
    if (action !== "CREATE" && action !== "MODIFY" && action !== "DELETE" && action !== "RENAME") return
    const resourceType = pending.resourceType || this.engine.store?.getBaseline(pending.path)?.resourceType ||
      localItems.find((item) => item.path === pending.path)?.resourceType
    if (!resourceType) return
    const local = localItems.find((item) => item.path === pending.path)
    this.updateLocalCaches({
      action,
      resourceType,
      path: pending.path,
      previousPath: pending.previousPath,
      contentHash: local?.contentHash || "",
      size: local?.size || 0,
    }, localItems)
  }

  private async applyLocalChange(change: SafeLocalChange, localItems: Array<{ resourceType: "NOTE" | "FILE" | "FOLDER"; path: string; contentHash: string; size: number }>): Promise<void> {
    if (change.action === "DELETE") {
      await this.deleteRemoteChange(change)
      this.updateLocalCaches(change, localItems)
      return
    }
    if (change.resourceType === "FOLDER") {
      const folder = this.plugin.app.vault.getAbstractFileByPath(normalizePath(change.path))
      if (!(folder instanceof TFolder)) throw new Error(`safe sync local folder changed during startup reconciliation: ${change.path}`)
      await this.mutateFolder({ action: change.action, path: change.path, previousPath: change.previousPath })
      this.updateLocalCaches(change, localItems)
      return
    }

    const file = this.plugin.app.vault.getFileByPath(normalizePath(change.path))
    if (!(file instanceof TFile)) throw new Error(`safe sync local file changed during startup reconciliation: ${change.path}`)
    if (change.resourceType === "NOTE") {
      const content = await this.plugin.app.vault.read(file)
      const contentHash = await hashContentAsync(content)
      const size = safeSyncTextSize(content)
      this.assertLocalSnapshot(change, contentHash, size)
      await this.mutateNote({
        action: change.action,
        path: change.path,
        previousPath: change.previousPath,
        content: change.action === "RENAME" ? undefined : content,
        contentHash,
        size,
        ctime: getSafeCtime(file.stat),
        mtime: file.stat.mtime,
      })
    } else if (change.action === "RENAME") {
      const contentHash = await hashFileAsync(this.plugin.app, file.path)
      this.assertLocalSnapshot(change, contentHash, file.stat.size)
      await this.mutateFile({
        action: "RENAME",
        path: change.path,
        previousPath: change.previousPath,
        contentHash,
        size: file.stat.size,
        ctime: getSafeCtime(file.stat),
        mtime: file.stat.mtime,
      })
    } else {
      await this.uploadLocalFile(change, file)
    }
    this.updateLocalCaches(change, localItems)
  }

  private reconciliationBaselines(localItems: Array<{ resourceType: "NOTE" | "FILE" | "FOLDER"; path: string }>) {
    const localPaths = new Set(localItems.map((item) => item.path))
    return (this.engine.store?.listBaselines() || []).filter((baseline) => {
      const excluded = baseline.resourceType === "FOLDER"
        ? isFolderSyncPathExcluded(baseline.path, this.plugin)
        : isPathExcluded(baseline.path, this.plugin)
      if (excluded) return false
      return baseline.state !== "LIVE" || baseline.resourceType !== "FILE" || localPaths.has(baseline.path) || !this.isCloudPreviewManaged(baseline.path)
    })
  }

  private isCloudPreviewManaged(path: string): boolean {
    if (!this.plugin.settings.cloudPreviewEnabled) return false
    if (!this.plugin.settings.cloudPreviewTypeRestricted) return true
    const dotIndex = path.lastIndexOf(".")
    return dotIndex >= 0 && FileCloudPreview.isRestrictedType(path.slice(dotIndex).toLowerCase())
  }

  private async deleteRemoteChange(change: SafeLocalChange): Promise<void> {
    const input = { action: "DELETE" as const, path: change.path }
    if (change.resourceType === "NOTE") await this.mutateNote(input)
    else if (change.resourceType === "FILE") await this.mutateFile(input)
    else await this.mutateFolder(input)
  }

  private async uploadLocalFile(change: SafeLocalChange, file: TFile): Promise<void> {
    const contentHash = await hashFileAsync(this.plugin.app, file.path)
    this.assertLocalSnapshot(change, contentHash, file.stat.size)
    const chunkSize = 1024 * 1024
    const upload = await this.startFileUpload({
      action: change.action,
      path: change.path,
      contentHash,
      size: file.stat.size,
      ctime: getSafeCtime(file.stat),
      mtime: file.stat.mtime,
    }, chunkSize)
    await receiveFileUpload({
      path: change.path,
      pathHash: hashContent(change.path),
      ctime: getSafeCtime(file.stat),
      mtime: file.stat.mtime,
      sessionId: upload.sessionId,
      chunkSize,
      nextChunkIndex: upload.nextChunkIndex,
      expectedContentHash: contentHash,
      awaitCompletion: true,
      onUploadReady: () => this.commitFileUpload(upload.operationId, upload.sessionId, contentHash, file.stat.size).then(() => undefined),
    }, this.plugin)
  }

  private assertLocalSnapshot(change: SafeLocalChange, contentHash: string, size: number): void {
    if (contentHash !== change.contentHash || size !== change.size) {
      throw new Error(`safe sync local content changed during startup reconciliation: ${change.path}`)
    }
  }

  private updateLocalCaches(change: SafeLocalChange, localItems: Array<{ resourceType: "NOTE" | "FILE" | "FOLDER"; path: string; contentHash: string; size: number }>): void {
    const previousPath = change.previousPath
    const affectedBaselines = this.engine.store?.listBaselines() || []
    if (change.resourceType === "FOLDER" && (change.action === "DELETE" || change.action === "RENAME")) {
      const oldRoot = previousPath || change.path
      const oldPaths = [...new Set([oldRoot, ...affectedBaselines.filter((item) => item.path.startsWith(`${oldRoot}/`)).map((item) => item.path)])]
      this.plugin.fileHashManager.removeFileHashes(oldPaths)
      this.plugin.folderSnapshotManager.removeFolders(oldPaths)
      for (const path of oldPaths) this.plugin.lastSyncMtime.delete(path)
    } else if (change.action === "DELETE") {
      this.plugin.fileHashManager.removeFileHash(change.path)
      this.plugin.folderSnapshotManager.removeFolder(change.path)
      this.plugin.lastSyncMtime.delete(change.path)
    } else if (previousPath) {
      this.plugin.fileHashManager.removeFileHash(previousPath)
      this.plugin.folderSnapshotManager.removeFolder(previousPath)
      this.plugin.lastSyncMtime.delete(previousPath)
    }

    if (change.action === "DELETE") return
    const newRoot = change.path
    const currentItems = change.resourceType === "FOLDER"
      ? localItems.filter((item) => item.path === newRoot || item.path.startsWith(`${newRoot}/`))
      : localItems.filter((item) => item.path === newRoot)
    for (const item of currentItems) {
      if (item.resourceType === "FOLDER") {
        this.plugin.folderSnapshotManager.setFolderMtime(item.path, Date.now())
        continue
      }
      const localFile = this.plugin.app.vault.getFileByPath(normalizePath(item.path))
      this.plugin.fileHashManager.setFileHash(item.path, item.contentHash, localFile?.stat.mtime || 0, localFile?.stat.size || item.size)
      this.plugin.lastSyncMtime.set(item.path, localFile?.stat.mtime || 0)
    }
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

function pendingNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}
