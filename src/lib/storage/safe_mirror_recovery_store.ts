import type FastSync from "../../main"
import { generateUUID, getPluginDir } from "../utils/helpers"
import type { SafeMirrorDirection, SafeMirrorResourceType } from "../sync/safe_mirror_plan"

export type SafeMirrorRecoveryStatus = "PREPARING" | "READY" | "APPLYING" | "COMPLETED" | "FAILED" | "ABORTED" | "ROLLED_BACK"

export const SAFE_MIRROR_RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const LATEST_OPERATION_STATUSES = new Set<SafeMirrorRecoveryStatus>(["APPLYING", "COMPLETED", "FAILED", "ROLLED_BACK"])

export interface SafeMirrorRecoveryEntry {
  path: string
  resourceType: SafeMirrorResourceType
  existed: boolean
  contentFile?: string
  contentHash: string
  size: number
  ctime?: number
  mtime?: number
}

export interface SafeMirrorRecoveryRecord {
  id: string
  direction: SafeMirrorDirection
  createdAt: number
  updatedAt: number
  status: SafeMirrorRecoveryStatus
  error?: string
  changes: number
  entries: SafeMirrorRecoveryEntry[]
}

export class SafeMirrorRecoveryStore {
  private readonly root: string

  constructor(private readonly plugin: FastSync) {
    this.root = `${getPluginDir(plugin)}/recovery/mirror`
  }

  async create(direction: SafeMirrorDirection, changes: number): Promise<SafeMirrorRecoveryRecord> {
    await this.pruneExpired()
    const now = Date.now()
    const record: SafeMirrorRecoveryRecord = {
      id: `${now}-${generateUUID()}`,
      direction,
      createdAt: now,
      updatedAt: now,
      status: "PREPARING",
      changes,
      entries: [],
    }
    await this.ensureDir(this.recordDir(record.id))
    await this.ensureDir(`${this.recordDir(record.id)}/content`)
    await this.save(record)
    return record
  }

  async addEntry(record: SafeMirrorRecoveryRecord, entry: SafeMirrorRecoveryEntry, content?: ArrayBuffer): Promise<void> {
    if (content) {
      const contentFile = `${this.recordDir(record.id)}/content/${generateUUID()}.bin`
      await this.plugin.app.vault.adapter.writeBinary(contentFile, content)
      entry.contentFile = contentFile
    }
    record.entries.push(entry)
    await this.save(record)
  }

  async update(record: SafeMirrorRecoveryRecord, status: SafeMirrorRecoveryStatus, error?: string): Promise<void> {
    record.status = status
    record.updatedAt = Date.now()
    if (error) record.error = error
    else delete record.error
    await this.save(record)
    if (LATEST_OPERATION_STATUSES.has(status)) {
      await this.plugin.app.vault.adapter.write(`${this.root}/latest.json`, JSON.stringify({ id: record.id }))
    }
  }

  async latest(): Promise<SafeMirrorRecoveryRecord | undefined> {
    await this.pruneExpired()
    try {
      const pointer = JSON.parse(await this.plugin.app.vault.adapter.read(`${this.root}/latest.json`)) as { id?: string }
      if (pointer.id) {
        const record = JSON.parse(await this.plugin.app.vault.adapter.read(this.recordFile(pointer.id))) as SafeMirrorRecoveryRecord
        if (LATEST_OPERATION_STATUSES.has(record.status)) return record
      }
    } catch {
      // Fall through and repair an old or stale pointer from the retained records.
    }
    try {
      const listing = await this.plugin.app.vault.adapter.list(this.root)
      const folders = [...listing.folders].sort((a, b) => recoveryCreatedAt(b) - recoveryCreatedAt(a))
      for (const folder of folders) {
        const id = folder.slice(folder.lastIndexOf("/") + 1)
        try {
          const record = JSON.parse(await this.plugin.app.vault.adapter.read(this.recordFile(id))) as SafeMirrorRecoveryRecord
          if (!LATEST_OPERATION_STATUSES.has(record.status)) continue
          await this.plugin.app.vault.adapter.write(`${this.root}/latest.json`, JSON.stringify({ id: record.id }))
          return record
        } catch {
          // A damaged record must not hide an older valid recovery point.
        }
      }
    } catch {
      // Missing recovery storage means there is no recoverable operation.
    }
    return undefined
  }

  readContent(entry: SafeMirrorRecoveryEntry): Promise<ArrayBuffer> {
    if (!entry.contentFile) throw new Error(`mirror recovery content is missing for ${entry.path}`)
    return this.plugin.app.vault.adapter.readBinary(entry.contentFile)
  }

  private async save(record: SafeMirrorRecoveryRecord): Promise<void> {
    record.updatedAt = Date.now()
    await this.ensureDir(this.recordDir(record.id))
    await this.plugin.app.vault.adapter.write(this.recordFile(record.id), JSON.stringify(record, null, 2))
  }

  private recordDir(id: string): string {
    return `${this.root}/${id}`
  }

  private recordFile(id: string): string {
    return `${this.recordDir(id)}/record.json`
  }

  private async ensureDir(path: string): Promise<void> {
    const adapter = this.plugin.app.vault.adapter
    const parts = path.split("/")
    let current = ""
    for (const part of parts) {
      if (!part) continue
      current = current ? `${current}/${part}` : part
      if (!(await adapter.exists(current))) await adapter.mkdir(current)
    }
  }

  private async pruneExpired(now = Date.now()): Promise<void> {
    const adapter = this.plugin.app.vault.adapter
    if (!(await adapter.exists(this.root))) return
    const listing = await adapter.list(this.root)
    const cutoff = now - SAFE_MIRROR_RECOVERY_RETENTION_MS
    for (const folder of listing.folders) {
      const id = folder.slice(folder.lastIndexOf("/") + 1)
      const createdAt = Number(id.split("-", 1)[0])
      if (Number.isFinite(createdAt) && createdAt < cutoff) await adapter.rmdir(folder, true)
    }
  }
}

function recoveryCreatedAt(folder: string): number {
  const id = folder.slice(folder.lastIndexOf("/") + 1)
  const createdAt = Number(id.split("-", 1)[0])
  return Number.isFinite(createdAt) ? createdAt : 0
}
