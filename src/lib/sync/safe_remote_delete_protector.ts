import { ensureDirectory, SafeRevisionBaseline } from "../storage/safe_sync_state_store"

export interface SafeRemoteDeleteStateStore {
  getBaseline(path: string): SafeRevisionBaseline | undefined
  hasPendingForPath(path: string): boolean
  applyRemoteBaseline(baseline: SafeRevisionBaseline): Promise<void>
}

export interface SafeDeleteAdapter {
  exists(path: string): Promise<boolean>
  readBinary(path: string): Promise<ArrayBuffer>
  writeBinary(path: string, data: ArrayBuffer): Promise<void>
  remove(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export interface SafeRemoteDeleteEvent {
  path: string
  resourceId: string
  resourceRevision: number
  vaultRevision: number
  contentHash: string
}

export type SafeRemoteDeleteResult =
  | { outcome: "deleted"; recoveryPath: string }
  | { outcome: "ignored" }
  | { outcome: "conflict"; reason: "unknown-baseline" | "pending-local-change" | "revision-mismatch" | "content-mismatch" | "recovery-failed" }

export class SafeRemoteDeleteProtector {
  constructor(
    private readonly adapter: SafeDeleteAdapter,
    private readonly stateStore: SafeRemoteDeleteStateStore,
    private readonly recoveryRoot: string,
    private readonly now: () => number = Date.now,
    private readonly commitBaseline: (baseline: SafeRevisionBaseline) => Promise<void> = (baseline) => stateStore.applyRemoteBaseline(baseline),
  ) {}

  async apply(event: SafeRemoteDeleteEvent, currentContentHash: string): Promise<SafeRemoteDeleteResult> {
    const baseline = this.stateStore.getBaseline(event.path)
    if (!baseline || baseline.resourceId !== event.resourceId || baseline.state !== "LIVE") {
      return { outcome: "conflict", reason: "unknown-baseline" }
    }
    if (this.stateStore.hasPendingForPath(event.path)) {
      return { outcome: "conflict", reason: "pending-local-change" }
    }
    if (event.resourceRevision !== baseline.resourceRevision + 1) {
      return { outcome: "conflict", reason: "revision-mismatch" }
    }
    if (!(await this.adapter.exists(event.path))) {
      await this.commitDeletedBaseline(event, baseline)
      return { outcome: "ignored" }
    }
    if (currentContentHash !== baseline.contentHash) {
      return { outcome: "conflict", reason: "content-mismatch" }
    }

    const recoveryPath = `${this.recoveryRoot}/${this.now()}/${event.path}`
    try {
      const content = await this.adapter.readBinary(event.path)
      await ensureDirectory(this.adapter, recoveryPath.substring(0, recoveryPath.lastIndexOf("/")))
      await this.adapter.writeBinary(recoveryPath, content)
      const verified = await this.adapter.readBinary(recoveryPath)
      if (verified.byteLength !== content.byteLength) throw new Error("recovery verification failed")
      await this.adapter.remove(event.path)
    } catch {
      return { outcome: "conflict", reason: "recovery-failed" }
    }
    await this.commitDeletedBaseline(event, baseline)
    return { outcome: "deleted", recoveryPath }
  }

  private async commitDeletedBaseline(event: SafeRemoteDeleteEvent, previous: SafeRevisionBaseline): Promise<void> {
    await this.commitBaseline({
      ...previous,
      resourceRevision: event.resourceRevision,
      vaultRevision: event.vaultRevision,
      contentHash: event.contentHash,
      state: "DELETED",
    })
  }
}
