import { normalizePath, TFile, TFolder } from "obsidian"

import type FastSync from "../../main"
import { HttpApiService } from "../api/http_api_service"
import { SafeMirrorRecoveryStore, type SafeMirrorRecoveryEntry, type SafeMirrorRecoveryRecord } from "../storage/safe_mirror_recovery_store"
import { generateUUID, getSafeCtime, hashArrayBuffer, hashContent, hashContentAsync, vaultDelete } from "../utils/helpers"
import { BINARY_PREFIX_FILE_SYNC, receiveFileUpload } from "./operator_file"
import {
  createSafeMirrorPlan,
  compareSafeMirrorDeletionOrder,
  safeMirrorPlanChangeCount,
  type SafeMirrorDirection,
  type SafeMirrorManifestItem,
  type SafeMirrorPlan,
  type SafeMirrorPlanItem,
  type SafeMirrorResourceType,
} from "./safe_mirror_plan"
import type { SafeMirrorBootstrapSnapshot } from "./safe_sync_engine"
import { safeSyncTextSize } from "./safe_sync_content"

export interface SafeMirrorSession {
  id: string
  createdAt: number
  snapshot: SafeMirrorBootstrapSnapshot
  localItems: SafeMirrorManifestItem[]
  plan: SafeMirrorPlan
}

export interface SafeMirrorProgress {
  completed: number
  total: number
  path: string
  phase: "BACKUP" | "APPLY" | "VERIFY" | "ROLLBACK"
}

type ProgressCallback = (progress: SafeMirrorProgress) => void

export class SafeMirrorManager {
  private readonly api: HttpApiService
  private readonly recovery: SafeMirrorRecoveryStore
  private activeSession?: SafeMirrorSession

  constructor(private readonly plugin: FastSync) {
    this.api = new HttpApiService(plugin)
    this.recovery = new SafeMirrorRecoveryStore(plugin)
  }

  get session(): SafeMirrorSession | undefined {
    return this.activeSession
  }

  async prepare(direction: SafeMirrorDirection): Promise<SafeMirrorSession> {
    if (!this.plugin.websocket.isConnected()) throw new Error("服务端未连接")
    if (this.activeSession) await this.cancel()
    const snapshot = await this.requireRuntime().engine.beginMirrorBootstrap()
    const localItems = await this.requireRuntime().engine.localManifest()
    const plan = createSafeMirrorPlan(direction, localItems, snapshot.remoteItems)
    this.activeSession = { id: generateUUID(), createdAt: Date.now(), snapshot, localItems, plan }
    return this.activeSession
  }

  async cancel(): Promise<void> {
    this.activeSession = undefined
    await this.cancelMirrorBootstrapPreservingPreference()
  }

  async apply(session: SafeMirrorSession, onProgress: ProgressCallback = () => undefined): Promise<SafeMirrorRecoveryRecord> {
    if (!this.activeSession || this.activeSession.id !== session.id) throw new Error("镜像计划已失效")
    let record: SafeMirrorRecoveryRecord | undefined
    let committed = false
    try {
      if (session.snapshot.expiresAt <= Date.now()) throw new Error("镜像计划已过期，请重新生成")
      if (safeMirrorPlanChangeCount(session.plan) === 0) throw new Error("本地与远端已经一致，无需覆盖")
      if (session.plan.direction === "LOCAL_TO_REMOTE" && this.plugin.settings.syncRole === "remote-mirror") {
        throw new Error("远端镜像端不能覆盖远端，请先切换为双向或本地发布端")
      }
      const currentLocal = await this.requireRuntime().engine.localManifest()
      if (safeMirrorPlanChangeCount(createSafeMirrorPlan("LOCAL_TO_REMOTE", currentLocal, session.localItems)) !== 0) {
        throw new Error("本地内容在预览后已变化，请重新生成差异预览")
      }

      record = await this.recovery.create(session.plan.direction, safeMirrorPlanChangeCount(session.plan))
      await this.captureTarget(session, record, onProgress)
      await this.recovery.update(record, "READY")
      await this.requireRuntime().engine.commitMirrorBootstrap(session.snapshot)
      committed = true
      this.activeSession = undefined
      this.plugin.settings.safeRevisionSyncEnabled = true
      await this.plugin.saveSettings()
      await this.recovery.update(record, "APPLYING")

      if (session.plan.direction === "LOCAL_TO_REMOTE") await this.applyLocalToRemote(session, onProgress)
      else await this.applyRemoteToLocal(session, onProgress)

      onProgress({ completed: 0, total: 1, path: "", phase: "VERIFY" })
      await this.verify(session.plan.direction)
      await this.recovery.update(record, "COMPLETED")
      return record
    } catch (error) {
      if (record) {
        await this.recovery.update(record, "FAILED", error instanceof Error ? error.message : String(error)).catch(() => undefined)
      }
      if (committed) {
        await this.requireRuntime().discardPendingForPaths(allPlanItems(session.plan).map((item) => item.path)).catch(() => undefined)
      }
      if (!committed) await this.cancel().catch(() => undefined)
      throw error
    }
  }

  async rollbackLatest(onProgress: ProgressCallback = () => undefined): Promise<SafeMirrorRecoveryRecord> {
    const record = await this.recovery.latest()
    if (!record || !["APPLYING", "COMPLETED", "FAILED"].includes(record.status)) throw new Error("没有可恢复的权威覆盖记录")
    if (record.direction === "REMOTE_TO_LOCAL") await this.restoreLocal(record, onProgress)
    else await this.restoreRemote(record, onProgress)
    await this.verifyRecovery(record)
    await this.recovery.update(record, "ROLLED_BACK")
    return record
  }

  private async captureTarget(session: SafeMirrorSession, record: SafeMirrorRecoveryRecord, onProgress: ProgressCallback): Promise<void> {
    const items = allPlanItems(session.plan)
    let completed = 0
    for (const item of items) {
      const target = item.target
      if (!target) {
        await this.recovery.addEntry(record, emptyRecoveryEntry(item.path, item.resourceType))
      } else if (session.plan.direction === "REMOTE_TO_LOCAL") {
        await this.captureLocalTarget(record, target)
      } else {
        await this.captureRemoteTarget(record, target)
      }
      onProgress({ completed: ++completed, total: items.length, path: item.path, phase: "BACKUP" })
    }
  }

  private async captureLocalTarget(record: SafeMirrorRecoveryRecord, target: SafeMirrorManifestItem): Promise<void> {
    const abstract = this.plugin.app.vault.getAbstractFileByPath(normalizePath(target.path))
    if (!abstract) {
      await this.recovery.addEntry(record, emptyRecoveryEntry(target.path, target.resourceType))
      return
    }
    if (abstract instanceof TFolder) {
      await this.recovery.addEntry(record, recoveryEntry(target, true))
      return
    }
    if (!(abstract instanceof TFile)) throw new Error(`无法读取本地恢复原像：${target.path}`)
    let content: ArrayBuffer
    let contentHash: string
    if (target.resourceType === "NOTE") {
      const text = await this.plugin.app.vault.read(abstract)
      content = textBuffer(text)
      contentHash = await hashContentAsync(text)
    } else {
      content = await this.plugin.app.vault.readBinary(abstract)
      contentHash = await hashArrayBuffer(content)
    }
    assertCapturedContent(target, contentHash, content.byteLength, "本地")
    await this.recovery.addEntry(record, {
      ...recoveryEntry(target, true),
      contentHash,
      size: abstract.stat.size,
      ctime: getSafeCtime(abstract.stat),
      mtime: abstract.stat.mtime,
    }, content)
  }

  private async captureRemoteTarget(record: SafeMirrorRecoveryRecord, target: SafeMirrorManifestItem): Promise<void> {
    if (target.resourceType === "FOLDER") {
      await this.recovery.addEntry(record, recoveryEntry(target, true))
      return
    }
    if (target.resourceType === "NOTE") {
      const note = await this.api.getNoteContent(target.path)
      const content = textBuffer(note.content)
      const contentHash = await hashContentAsync(note.content)
      assertCapturedContent(target, contentHash, content.byteLength, "远端")
      await this.recovery.addEntry(record, {
        ...recoveryEntry(target, true), contentHash, size: content.byteLength, ctime: note.ctime, mtime: note.mtime,
      }, content)
      return
    }
    const [info, content] = await Promise.all([this.api.getFileInfo(target.path), this.api.downloadFileContent(target.path)])
    const contentHash = await hashArrayBuffer(content)
    assertCapturedContent(target, contentHash, content.byteLength, "远端")
    await this.recovery.addEntry(record, {
      ...recoveryEntry(target, true), contentHash, ctime: 0, mtime: info.mtime, size: content.byteLength,
    }, content)
  }

  private async applyLocalToRemote(session: SafeMirrorSession, onProgress: ProgressCallback): Promise<void> {
    const deletions = [...session.plan.deletes, ...session.plan.replacements]
      .sort((a, b) => compareSafeMirrorDeletionOrder(a.target!, b.target!))
    const creations = [...session.plan.creates, ...session.plan.replacements]
      .sort((a, b) => createOrder(a, b))
    const work = [...deletions, ...creations, ...session.plan.updates]
    let completed = 0
    for (const item of deletions) {
      if (!item.target) continue
      await this.deleteRemote(item.target)
      onProgress({ completed: ++completed, total: work.length, path: item.path, phase: "APPLY" })
    }
    for (const item of creations) {
      if (!item.source) continue
      await this.writeRemote(item.source, "CREATE")
      onProgress({ completed: ++completed, total: work.length, path: item.path, phase: "APPLY" })
    }
    for (const item of session.plan.updates) {
      if (!item.source) continue
      await this.writeRemote(item.source, "MODIFY")
      onProgress({ completed: ++completed, total: work.length, path: item.path, phase: "APPLY" })
    }
  }

  private async applyRemoteToLocal(session: SafeMirrorSession, onProgress: ProgressCallback): Promise<void> {
    const deletions = [...session.plan.deletes, ...session.plan.replacements]
      .sort((a, b) => compareSafeMirrorDeletionOrder(a.target!, b.target!))
    const writes = [...session.plan.creates, ...session.plan.replacements, ...session.plan.updates].sort((a, b) => createOrder(a, b))
    const total = deletions.length + writes.length
    let completed = 0
    for (const item of deletions) {
      await this.deleteLocal(item.path)
      onProgress({ completed: ++completed, total, path: item.path, phase: "APPLY" })
    }
    for (const item of writes) {
      if (!item.source) continue
      await this.writeLocalFromRemote(item.source)
      onProgress({ completed: ++completed, total, path: item.path, phase: "APPLY" })
    }
  }

  private async writeRemote(item: SafeMirrorManifestItem, action: "CREATE" | "MODIFY"): Promise<void> {
    const runtime = this.requireRuntime()
    const local = this.plugin.app.vault.getAbstractFileByPath(normalizePath(item.path))
    if (item.resourceType === "FOLDER") {
      await runtime.mutateFolder({ action, path: item.path })
      return
    }
    if (!(local instanceof TFile)) throw new Error(`本地源文件不存在：${item.path}`)
    if (item.resourceType === "NOTE") {
      const content = await this.plugin.app.vault.read(local)
      await runtime.mutateNote({ action, path: item.path, content, contentHash: item.contentHash, size: safeSyncTextSize(content), ctime: getSafeCtime(local.stat), mtime: local.stat.mtime })
      return
    }
    const chunkSize = 1024 * 1024
    const upload = await runtime.startFileUpload({ action, path: item.path, contentHash: item.contentHash, size: local.stat.size, ctime: getSafeCtime(local.stat), mtime: local.stat.mtime }, chunkSize)
    await receiveFileUpload({
      path: item.path,
      pathHash: hashContent(item.path),
      ctime: getSafeCtime(local.stat),
      mtime: local.stat.mtime,
      sessionId: upload.sessionId,
      chunkSize,
      nextChunkIndex: upload.nextChunkIndex,
      awaitCompletion: true,
      onUploadReady: () => runtime.commitFileUpload(upload.operationId, upload.sessionId, item.contentHash, local.stat.size).then(() => undefined),
    }, this.plugin)
  }

  private async deleteRemote(item: SafeMirrorManifestItem): Promise<void> {
    const input = { action: "DELETE" as const, path: item.path }
    if (item.resourceType === "NOTE") await this.requireRuntime().mutateNote(input)
    else if (item.resourceType === "FILE") await this.requireRuntime().mutateFile(input)
    else await this.requireRuntime().mutateFolder(input)
  }

  private async writeLocalFromRemote(item: SafeMirrorManifestItem): Promise<void> {
    if (item.resourceType === "FOLDER") {
      await this.ensureLocalFolder(item.path)
      this.plugin.folderSnapshotManager.setFolderMtime(item.path, Date.now())
      return
    }
    let content: ArrayBuffer
    let ctime = Date.now()
    let mtime = Date.now()
    if (item.resourceType === "NOTE") {
      const note = await this.api.getNoteContent(item.path)
      content = textBuffer(note.content)
      ctime = note.ctime
      mtime = note.mtime
    } else {
      const [info, downloaded] = await Promise.all([this.api.getFileInfo(item.path), this.api.downloadFileContent(item.path)])
      content = downloaded
      mtime = info.mtime
    }
    await this.writeLocalBinary(item.path, content, ctime, mtime, item.contentHash)
  }

  private async deleteLocal(path: string): Promise<void> {
    const target = this.plugin.app.vault.getAbstractFileByPath(normalizePath(path))
    if (!target) return
    this.plugin.addIgnoredFile(path)
    try {
      await vaultDelete(this.plugin.app.vault, target, true)
      this.plugin.fileHashManager.removeFileHash(path)
      this.plugin.folderSnapshotManager.removeFolder(path)
    } finally {
      this.plugin.removeIgnoredFile(path)
    }
  }

  private async writeLocalBinary(path: string, content: ArrayBuffer, ctime: number, mtime: number, contentHash?: string): Promise<void> {
    await this.ensureLocalFolder(parentPath(path))
    const normalized = normalizePath(path)
    const existing = this.plugin.app.vault.getAbstractFileByPath(normalized)
    this.plugin.addIgnoredFile(path)
    try {
      if (existing instanceof TFolder) await vaultDelete(this.plugin.app.vault, existing, true)
      const file = this.plugin.app.vault.getFileByPath(normalized)
      if (file) await this.plugin.app.vault.modifyBinary(file, content, { ctime, mtime })
      else await this.plugin.app.vault.createBinary(normalized, content, { ctime, mtime })
      const written = this.plugin.app.vault.getFileByPath(normalized)
      if (written && contentHash) this.plugin.fileHashManager.setFileHash(path, contentHash, written.stat.mtime, written.stat.size)
    } finally {
      this.plugin.removeIgnoredFile(path)
    }
  }

  private async ensureLocalFolder(path: string): Promise<void> {
    const normalized = normalizePath(path)
    if (!normalized || normalized === "/") return
    const parts = normalized.split("/")
    let current = ""
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      const existing = this.plugin.app.vault.getAbstractFileByPath(current)
      if (existing instanceof TFile) await vaultDelete(this.plugin.app.vault, existing, true)
      if (!this.plugin.app.vault.getAbstractFileByPath(current)) await this.plugin.app.vault.createFolder(current)
    }
  }

  private async verify(direction: SafeMirrorDirection): Promise<void> {
    const local = await this.requireRuntime().engine.localManifest()
    const snapshot = await this.requireRuntime().engine.beginMirrorBootstrap()
    try {
      const remaining = createSafeMirrorPlan(direction, local, snapshot.remoteItems)
      if (safeMirrorPlanChangeCount(remaining) !== 0) throw new Error("覆盖后本地与当前远端哈希校验不一致")
    } finally {
      await this.cancelMirrorBootstrapPreservingPreference()
    }
  }

  private async restoreLocal(record: SafeMirrorRecoveryRecord, onProgress: ProgressCallback): Promise<void> {
    const entries = [...record.entries].sort((a, b) => a.resourceType === "FOLDER" ? -1 : b.resourceType === "FOLDER" ? 1 : a.path.localeCompare(b.path))
    let completed = 0
    for (const entry of entries) {
      if (!entry.existed) await this.deleteLocal(entry.path)
      else if (entry.resourceType === "FOLDER") await this.ensureLocalFolder(entry.path)
      else await this.writeLocalBinary(entry.path, await this.recovery.readContent(entry), entry.ctime || Date.now(), entry.mtime || Date.now(), entry.contentHash)
      onProgress({ completed: ++completed, total: entries.length, path: entry.path, phase: "ROLLBACK" })
    }
  }

  private async restoreRemote(record: SafeMirrorRecoveryRecord, onProgress: ProgressCallback): Promise<void> {
    const runtime = this.requireRuntime()
    if (runtime.status.state !== "active") throw new Error("安全同步未激活，不能恢复远端")
    const entries = [...record.entries]
    let completed = 0
    for (const entry of entries.filter((item) => !item.existed).sort(compareSafeMirrorDeletionOrder)) {
      const current = runtime.baselineAt(entry.path)
      if (current?.state === "LIVE") await this.deleteRemote({ ...entry, resourceType: current.resourceType || entry.resourceType })
      onProgress({ completed: ++completed, total: entries.length, path: entry.path, phase: "ROLLBACK" })
    }
    for (const entry of entries.filter((item) => item.existed).sort((a, b) => a.resourceType === "FOLDER" ? -1 : b.resourceType === "FOLDER" ? 1 : a.path.localeCompare(b.path))) {
      const current = runtime.baselineAt(entry.path)
      if (current?.state === "LIVE" && current.resourceType && current.resourceType !== entry.resourceType) {
        await this.deleteRemote({ ...entry, resourceType: current.resourceType })
      }
      const baseline = runtime.hasLiveBaseline(entry.path)
      if (entry.resourceType === "FOLDER") {
        await runtime.mutateFolder({ action: baseline ? "MODIFY" : "CREATE", path: entry.path })
      } else if (entry.resourceType === "NOTE") {
        const content = new TextDecoder().decode(await this.recovery.readContent(entry))
        await runtime.mutateNote({ action: baseline ? "MODIFY" : "CREATE", path: entry.path, content, contentHash: entry.contentHash, size: safeSyncTextSize(content), ctime: entry.ctime, mtime: entry.mtime })
      } else {
        await this.writeRemoteFileContent(entry, await this.recovery.readContent(entry), baseline ? "MODIFY" : "CREATE")
      }
      onProgress({ completed: ++completed, total: entries.length, path: entry.path, phase: "ROLLBACK" })
    }
  }

  private async verifyRecovery(record: SafeMirrorRecoveryRecord): Promise<void> {
    let manifest: SafeMirrorManifestItem[]
    if (record.direction === "REMOTE_TO_LOCAL") {
      manifest = await this.requireRuntime().engine.localManifest()
    } else {
      const snapshot = await this.requireRuntime().engine.beginMirrorBootstrap()
      try {
        manifest = snapshot.remoteItems
      } finally {
        await this.cancelMirrorBootstrapPreservingPreference()
      }
    }
    const live = new Map(manifest.filter((item) => item.state !== "DELETED").map((item) => [item.path, item]))
    for (const entry of record.entries) {
      const actual = live.get(entry.path)
      if (!entry.existed) {
        if (actual) throw new Error(`回滚校验失败，目标仍然存在：${entry.path}`)
        continue
      }
      if (!actual || actual.resourceType !== entry.resourceType) throw new Error(`回滚校验失败，目标类型不一致：${entry.path}`)
      if (entry.resourceType !== "FOLDER" && (actual.contentHash !== entry.contentHash || actual.size !== entry.size)) {
        throw new Error(`回滚校验失败，内容哈希不一致：${entry.path}`)
      }
    }
  }

  private requireRuntime() {
    const runtime = this.plugin.safeSyncRuntime
    if (!runtime) throw new Error("安全同步运行时尚未初始化")
    return runtime
  }

  private async cancelMirrorBootstrapPreservingPreference(): Promise<void> {
    await this.requireRuntime().engine.cancelMirrorBootstrap(this.plugin.settings.safeRevisionSyncEnabled)
  }

  private async writeRemoteFileContent(entry: SafeMirrorRecoveryEntry, content: ArrayBuffer, action: "CREATE" | "MODIFY"): Promise<void> {
    const runtime = this.requireRuntime()
    const chunkSize = 1024 * 1024
    const upload = await runtime.startFileUpload({
      action,
      path: entry.path,
      contentHash: entry.contentHash,
      size: content.byteLength,
      ctime: entry.ctime,
      mtime: entry.mtime,
    }, chunkSize)
    const totalChunks = content.byteLength === 0 ? 1 : Math.ceil(content.byteLength / chunkSize)
    const sessionIdBytes = new TextEncoder().encode(upload.sessionId)
    for (let index = upload.nextChunkIndex; index < totalChunks; index++) {
      const start = index * chunkSize
      const end = Math.min(start + chunkSize, content.byteLength)
      const chunk = new Uint8Array(content, start, end - start)
      const frame = new Uint8Array(40 + chunk.byteLength)
      frame.set(sessionIdBytes, 0)
      new DataView(frame.buffer).setUint32(36, index, false)
      frame.set(chunk, 40)
      const result = await this.plugin.websocket.SendBinary(frame, BINARY_PREFIX_FILE_SYNC)
      if (result !== "sent") throw new Error(`恢复远端附件上传中断：${entry.path}`)
    }
    await runtime.commitFileUpload(upload.operationId, upload.sessionId, entry.contentHash, content.byteLength)
  }
}

function allPlanItems(plan: SafeMirrorPlan): SafeMirrorPlanItem[] {
  return [...plan.creates, ...plan.updates, ...plan.deletes, ...plan.replacements]
}

function recoveryEntry(item: SafeMirrorManifestItem, existed: boolean): SafeMirrorRecoveryEntry {
  return { path: item.path, resourceType: item.resourceType, existed, contentHash: item.contentHash, size: item.size }
}

function emptyRecoveryEntry(path: string, resourceType: SafeMirrorResourceType): SafeMirrorRecoveryEntry {
  return { path, resourceType, existed: false, contentHash: "", size: 0 }
}

function textBuffer(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/")
  return index < 0 ? "" : path.slice(0, index)
}

function createOrder(a: SafeMirrorPlanItem, b: SafeMirrorPlanItem): number {
  if (a.source?.resourceType === "FOLDER" && b.source?.resourceType !== "FOLDER") return -1
  if (a.source?.resourceType !== "FOLDER" && b.source?.resourceType === "FOLDER") return 1
  return a.path.split("/").length - b.path.split("/").length
}

function assertCapturedContent(target: SafeMirrorManifestItem, contentHash: string, size: number, side: "本地" | "远端"): void {
  if (contentHash !== target.contentHash || size !== target.size) {
    throw new Error(`${side}内容在预览后已变化：${target.path}`)
  }
}
