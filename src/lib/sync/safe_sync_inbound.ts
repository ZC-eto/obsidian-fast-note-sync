import { normalizePath, TFile, TFolder } from "obsidian"

import type FastSync from "../../main"
import type { FolderSyncRenameMessage, ReceiveMessage, ReceivePathMessage } from "../utils/types"
import { hashContentAsync, hashFileAsync, vaultDelete } from "../utils/helpers"
import type { SafeSyncEvent } from "./safe_sync_engine"

type RenameMessage = {
  path: string
  oldPath: string
  contentHash?: string
  mtime?: number
  lastTime?: number
}

export async function receiveSafeDirectEvent(event: SafeSyncEvent, plugin: FastSync): Promise<void> {
  if (event.action === "DELETE") {
    if (event.resourceType === "NOTE") {
      await receiveSafeNoteDelete({ path: event.path } as ReceiveMessage, plugin)
    } else if (event.resourceType === "FILE") {
      await receiveSafeFileDelete({ path: event.path }, plugin)
    } else {
      await receiveSafeFolderDelete({ path: event.path }, plugin)
    }
    return
  }
  if (event.action !== "RENAME" || !event.previousPath) {
    throw new Error(`safe sync event ${event.vaultRevision} requires a content payload`)
  }
  if (event.resourceType === "NOTE") {
    await receiveSafeNoteRename({ path: event.path, oldPath: event.previousPath, contentHash: event.contentHash }, plugin)
  } else if (event.resourceType === "FILE") {
    await receiveSafeFileRename({ path: event.path, oldPath: event.previousPath, contentHash: event.contentHash }, plugin)
  } else {
    await receiveSafeFolderRename({
      path: event.path,
      pathHash: "",
      ctime: 0,
      mtime: 0,
      oldPath: event.previousPath,
      oldPathHash: "",
    }, plugin)
  }
}

export async function receiveSafeNoteModify(data: ReceiveMessage, plugin: FastSync): Promise<void> {
  const runtime = requireRuntime(plugin)
  const event = await requireEvent(runtime.claimRemoteEvent("NOTE", "UPSERT", data.path, "", data.contentHash))
  try {
    const incomingHash = await hashContentAsync(data.content || "")
    if (event.contentHash && incomingHash !== event.contentHash) throw new Error(`safe sync note payload hash mismatch at ${data.path}`)
    const path = normalizePath(data.path)
    await plugin.lockManager.withLock(path, async () => {
      const existing = plugin.app.vault.getFileByPath(path)
      const currentHash = existing instanceof TFile ? await hashContentAsync(await plugin.app.vault.read(existing)) : null
      const shouldApply = runtime.verifyRemoteEvent(event, currentHash)
      plugin.addIgnoredFile(path)
      try {
        if (shouldApply && existing instanceof TFile) {
          await plugin.app.vault.modify(existing, data.content, noteTimes(data))
        } else if (shouldApply) {
          await ensureParentFolder(path, plugin)
          await plugin.app.vault.create(path, data.content, noteTimes(data))
        }
        const updated = plugin.app.vault.getFileByPath(path)
        if (!(updated instanceof TFile)) throw new Error(`safe sync note is missing after apply: ${path}`)
        await runtime.commitRemoteEvent(event, incomingHash, updated.stat.size)
        plugin.fileHashManager.setFileHash(data.path, incomingHash, updated.stat.mtime, updated.stat.size)
        plugin.lastSyncMtime.set(data.path, updated.stat.mtime)
        plugin.pendingNoteModifies.delete(data.path)
        plugin.localStorageManager.savePending("pendingNoteModifies", plugin.pendingNoteModifies)
        plugin.pendingNoteDeleteAcks.delete(data.path)
      } finally {
        window.setTimeout(() => plugin.removeIgnoredFile(path), 500)
      }
    }, { maxRetries: 5, retryInterval: 100 })
    updateSyncTime(plugin, "lastNoteSyncTime", data.lastTime)
  } catch (error) {
    runtime.rejectRemoteEvent(event, error)
    throw error
  }
}

export async function receiveSafeNoteDelete(data: ReceiveMessage, plugin: FastSync): Promise<void> {
  const runtime = requireRuntime(plugin)
  const event = await requireEvent(runtime.claimRemoteEvent("NOTE", "DELETE", data.path))
  try {
    const path = normalizePath(data.path)
    const existing = plugin.app.vault.getFileByPath(path)
    const currentHash = existing instanceof TFile ? await hashContentAsync(await plugin.app.vault.read(existing)) : ""
    plugin.addIgnoredFile(path)
    plugin.lastSyncPathDeleted.add(path)
    try {
      await runtime.protectRemoteDelete(event, currentHash)
      plugin.fileHashManager.removeFileHash(path)
      plugin.lastSyncMtime.delete(path)
      plugin.pendingNoteModifies.delete(path)
      plugin.localStorageManager.savePending("pendingNoteModifies", plugin.pendingNoteModifies)
    } finally {
      window.setTimeout(() => {
        plugin.removeIgnoredFile(path)
        plugin.lastSyncPathDeleted.delete(path)
      }, 500)
    }
    updateSyncTime(plugin, "lastNoteSyncTime", data.lastTime)
  } catch (error) {
    runtime.rejectRemoteEvent(event, error)
    throw error
  }
}

export async function receiveSafeNoteRename(data: RenameMessage, plugin: FastSync): Promise<void> {
  await receiveSafeRename("NOTE", data, plugin)
  updateSyncTime(plugin, "lastNoteSyncTime", data.lastTime)
}

export async function receiveSafeFileDelete(data: ReceivePathMessage, plugin: FastSync): Promise<void> {
  const runtime = requireRuntime(plugin)
  const event = await requireEvent(runtime.claimRemoteEvent("FILE", "DELETE", data.path))
  try {
    const path = normalizePath(data.path)
    const existing = plugin.app.vault.getFileByPath(path)
    const currentHash = existing instanceof TFile ? await hashFileAsync(plugin.app, path) : ""
    plugin.addIgnoredFile(path)
    plugin.lastSyncPathDeleted.add(path)
    try {
      await runtime.protectRemoteDelete(event, currentHash)
      plugin.fileHashManager.removeFileHash(path)
      plugin.lastSyncMtime.delete(path)
    } finally {
      window.setTimeout(() => {
        plugin.removeIgnoredFile(path)
        plugin.lastSyncPathDeleted.delete(path)
      }, 500)
    }
    updateSyncTime(plugin, "lastFileSyncTime", data.lastTime)
  } catch (error) {
    runtime.rejectRemoteEvent(event, error)
    throw error
  }
}

export async function receiveSafeFileRename(data: RenameMessage, plugin: FastSync): Promise<void> {
  await receiveSafeRename("FILE", data, plugin)
  updateSyncTime(plugin, "lastFileSyncTime", data.lastTime)
}

export async function receiveSafeFolderModify(
  data: { path: string; mtime?: number; lastTime?: number },
  plugin: FastSync,
): Promise<void> {
  const runtime = requireRuntime(plugin)
  const event = await requireEvent(runtime.claimRemoteEvent("FOLDER", "UPSERT", data.path))
  try {
    const path = normalizePath(data.path)
    await plugin.lockManager.withLock(path, async () => {
      const existing = plugin.app.vault.getAbstractFileByPath(path)
      const shouldApply = runtime.verifyRemoteEvent(event, existing instanceof TFolder ? "" : null)
      if (existing && !(existing instanceof TFolder)) throw new Error(`safe sync folder target is occupied: ${path}`)
      plugin.addIgnoredFile(path)
      try {
        if (shouldApply) await plugin.app.vault.createFolder(path)
        await runtime.commitRemoteEvent(event, "", 0)
        plugin.folderSnapshotManager.setFolderMtime(path, data.mtime || Date.now())
      } finally {
        window.setTimeout(() => plugin.removeIgnoredFile(path), 500)
      }
    }, { maxRetries: 5, retryInterval: 100 })
    updateSyncTime(plugin, "lastFolderSyncTime", data.lastTime)
  } catch (error) {
    runtime.rejectRemoteEvent(event, error)
    throw error
  }
}

export async function receiveSafeFolderDelete(
  data: { path: string; lastTime?: number },
  plugin: FastSync,
): Promise<void> {
  const runtime = requireRuntime(plugin)
  const event = await requireEvent(runtime.claimRemoteEvent("FOLDER", "DELETE", data.path))
  try {
    const path = normalizePath(data.path)
    await plugin.lockManager.withLock(path, async () => {
      const folder = plugin.app.vault.getAbstractFileByPath(path)
      if (folder && !(folder instanceof TFolder)) throw new Error(`safe sync folder path is not a folder: ${path}`)
      if (folder instanceof TFolder && folder.children.length > 0) throw new Error(`safe sync refused to delete non-empty folder: ${path}`)
      plugin.addIgnoredFile(path)
      plugin.lastSyncPathDeleted.add(path)
      try {
        if (folder instanceof TFolder) await vaultDelete(plugin.app.vault, folder, true)
        await runtime.commitRemoteEvent(event, "", 0)
        plugin.folderSnapshotManager.removeFolder(path)
      } finally {
        window.setTimeout(() => {
          plugin.removeIgnoredFile(path)
          plugin.lastSyncPathDeleted.delete(path)
        }, 500)
      }
    }, { maxRetries: 5, retryInterval: 100 })
    updateSyncTime(plugin, "lastFolderSyncTime", data.lastTime)
  } catch (error) {
    runtime.rejectRemoteEvent(event, error)
    throw error
  }
}

export async function receiveSafeFolderRename(data: FolderSyncRenameMessage, plugin: FastSync): Promise<void> {
  const runtime = requireRuntime(plugin)
  const event = await requireEvent(runtime.claimRemoteEvent("FOLDER", "RENAME", data.path, data.oldPath))
  try {
    const oldPath = normalizePath(data.oldPath)
    const newPath = normalizePath(data.path)
    await plugin.lockManager.withLock(newPath, async () => {
      const source = plugin.app.vault.getAbstractFileByPath(oldPath)
      const target = plugin.app.vault.getAbstractFileByPath(newPath)
      if (source && !(source instanceof TFolder)) throw new Error(`safe sync folder rename source is not a folder: ${oldPath}`)
      if (target && !(target instanceof TFolder)) throw new Error(`safe sync folder rename target is occupied: ${newPath}`)
      const shouldApply = runtime.verifyRemoteEvent(event, source instanceof TFolder ? "" : null, target instanceof TFolder ? "" : null)
      plugin.addIgnoredFile(oldPath)
      plugin.addIgnoredFile(newPath)
      plugin.lastSyncPathRenamed.add(newPath)
      try {
        if (shouldApply && source instanceof TFolder) await plugin.app.vault.rename(source, newPath)
        await runtime.commitRemoteEvent(event, "", 0)
        plugin.folderSnapshotManager.removeFolder(oldPath)
        plugin.folderSnapshotManager.setFolderMtime(newPath, data.mtime || Date.now())
      } finally {
        window.setTimeout(() => {
          plugin.removeIgnoredFile(oldPath)
          plugin.removeIgnoredFile(newPath)
          plugin.lastSyncPathRenamed.delete(newPath)
        }, 500)
      }
    }, { maxRetries: 5, retryInterval: 100 })
    updateSyncTime(plugin, "lastFolderSyncTime", data.lastTime)
  } catch (error) {
    runtime.rejectRemoteEvent(event, error)
    throw error
  }
}

async function receiveSafeRename(resourceType: "NOTE" | "FILE", data: RenameMessage, plugin: FastSync): Promise<void> {
  const runtime = requireRuntime(plugin)
  const event = await requireEvent(runtime.claimRemoteEvent(resourceType, "RENAME", data.path, data.oldPath, data.contentHash || ""))
  try {
    const oldPath = normalizePath(data.oldPath)
    const newPath = normalizePath(data.path)
    await plugin.lockManager.withLock(newPath, async () => {
      const source = plugin.app.vault.getFileByPath(oldPath)
      const target = plugin.app.vault.getFileByPath(newPath)
      const sourceHash = source instanceof TFile ? await contentHash(resourceType, oldPath, source, plugin) : null
      const targetHash = target instanceof TFile ? await contentHash(resourceType, newPath, target, plugin) : null
      const shouldApply = runtime.verifyRemoteEvent(event, sourceHash, targetHash)
      plugin.addIgnoredFile(oldPath)
      plugin.addIgnoredFile(newPath)
      plugin.lastSyncPathRenamed.add(newPath)
      try {
        if (shouldApply && source instanceof TFile) await plugin.app.vault.rename(source, newPath)
        const renamed = plugin.app.vault.getFileByPath(newPath)
        if (!(renamed instanceof TFile)) throw new Error(`safe sync rename target is missing: ${newPath}`)
        const finalHash = await contentHash(resourceType, newPath, renamed, plugin)
        if (event.contentHash && finalHash !== event.contentHash) throw new Error(`safe sync rename target hash mismatch at ${newPath}`)
        await runtime.commitRemoteEvent(event, finalHash, renamed.stat.size)
        plugin.fileHashManager.removeFileHash(data.oldPath)
        plugin.fileHashManager.setFileHash(data.path, finalHash, renamed.stat.mtime, renamed.stat.size)
      } finally {
        window.setTimeout(() => {
          plugin.removeIgnoredFile(oldPath)
          plugin.removeIgnoredFile(newPath)
          plugin.lastSyncPathRenamed.delete(newPath)
        }, 500)
      }
    }, { maxRetries: 10, retryInterval: 100 })
  } catch (error) {
    runtime.rejectRemoteEvent(event, error)
    throw error
  }
}

async function contentHash(resourceType: "NOTE" | "FILE", path: string, file: TFile, plugin: FastSync): Promise<string> {
  return resourceType === "NOTE" ? hashContentAsync(await plugin.app.vault.read(file)) : hashFileAsync(plugin.app, path)
}

async function ensureParentFolder(path: string, plugin: FastSync): Promise<void> {
  const parent = path.split("/").slice(0, -1).join("/")
  if (parent && !plugin.app.vault.getFolderByPath(parent)) {
    throw new Error(`safe sync note parent folder is missing: ${parent}`)
  }
}

function noteTimes(data: ReceiveMessage): { ctime?: number; mtime?: number } {
  return { ...(data.ctime > 0 && { ctime: data.ctime }), ...(data.mtime > 0 && { mtime: data.mtime }) }
}

function updateSyncTime(
  plugin: FastSync,
  key: "lastNoteSyncTime" | "lastFileSyncTime" | "lastFolderSyncTime",
  lastTime?: number,
): void {
  if (lastTime && lastTime > Number(plugin.localStorageManager.getMetadata(key))) {
    plugin.localStorageManager.setMetadata(key, lastTime)
  }
}

function requireRuntime(plugin: FastSync): NonNullable<FastSync["safeSyncRuntime"]> {
  if (!plugin.safeSyncRuntime) throw new Error("safe sync runtime is not initialized")
  return plugin.safeSyncRuntime
}

async function requireEvent(promise: Promise<SafeSyncEvent | undefined>): Promise<SafeSyncEvent> {
  const event = await promise
  if (!event) throw new Error("safe sync event is unavailable")
  return event
}
