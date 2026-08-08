import {
  SAFE_SYNC_OPERATION_RETENTION_MS,
  SafeMutationAck,
  SafePendingMutation,
  SafeRevisionBaseline,
  SafeSyncStateStore,
  createSafeSyncServerFingerprint,
} from "../storage/safe_sync_state_store"

export type SafeSyncClientState =
  | "disabled"
  | "unsupported"
  | "activating"
  | "bootstrapping"
  | "active"
  | "strict-vault-local-disabled"
  | "error"

export interface SafeSyncClientStatus {
  state: SafeSyncClientState
  serverState: "OFF" | "BOOTSTRAPPING" | "STRICT" | "UNKNOWN"
  capability: boolean
  message?: string
}

export interface SafeSyncTransport {
  request(action: SafeSyncRequestAction, payload: Record<string, unknown>): Promise<Record<string, unknown>>
}

export type SafeSyncRequestAction =
  | "SafeSyncStatus"
  | "SafeSyncBootstrapStart"
  | "SafeSyncBootstrapPage"
  | "SafeSyncBootstrapCommit"
  | "SafeSyncBootstrapCancel"
  | "SafeSyncEvents"
  | "SafeNoteMutation"
  | "SafeFolderMutation"
  | "SafeFileMutation"
  | "SafeFileUploadStart"
  | "SafeFileUploadCommit"
  | "DeviceRoleRegister"

export interface SafeLocalManifestItem {
  resourceType: "NOTE" | "FILE" | "FOLDER"
  path: string
  contentHash: string
  size: number
}

export interface SafeSyncManifestMismatch {
  path: string
  reason: "local-only" | "missing-local" | "content-mismatch" | "type-mismatch" | "tombstone-local-exists"
}

export interface SafeSyncEvent {
  vaultRevision: number
  resourceId: string
  resourceRevision: number
  resourceType: "NOTE" | "FILE" | "FOLDER"
  action: "CREATE" | "MODIFY" | "DELETE" | "RENAME"
  path: string
  previousPath?: string
  contentHash: string
  state: "LIVE" | "DELETED"
  transactionId?: string
  operationId?: string
}

export interface SafeMutationInput {
  action: "CREATE" | "MODIFY" | "DELETE" | "RENAME"
  path: string
  previousPath?: string
  content?: string
  contentHash?: string
  size?: number
  ctime?: number
  mtime?: number
}

export interface SafeFileUploadSession {
  sessionId: string
  operationId: string
  nextChunkIndex: number
  expiresAt: number
}

interface SafeSyncStateStoreLike {
  readonly deviceId: string
  readonly bootstrapComplete: boolean
  readonly latestVaultRevision: number
  initialize(): Promise<void>
  expirePending(now?: number): Promise<SafePendingMutation[]>
  listBaselines(): SafeRevisionBaseline[]
  getBaseline(path: string): SafeRevisionBaseline | undefined
  getPending(operationId: string): SafePendingMutation | undefined
  hasPendingForPath(path: string): boolean
  listRetryablePending(now?: number): SafePendingMutation[]
  replaceBootstrapBaselines(baselines: SafeRevisionBaseline[], latestVaultRevision: number): Promise<void>
  putPending(pending: SafePendingMutation): Promise<void>
  acknowledge(ack: SafeMutationAck): Promise<void>
  applyRemoteBaseline(baseline: SafeRevisionBaseline, previousPath?: string): Promise<void>
  advanceVaultRevision(vaultRevision: number): Promise<void>
}

interface SafeRemoteEventClaim {
  event: SafeSyncEvent
  released: boolean
  resolve(event: SafeSyncEvent): void
  reject(error: Error): void
}

interface SafeSyncEngineOptions {
  vault: string
  serverUrl: string
  transport: SafeSyncTransport
  createStateStore(identity: { serverFingerprint: string; uid: number; vaultId: number }): SafeSyncStateStore | SafeSyncStateStoreLike
  getLocalManifest(): Promise<SafeLocalManifestItem[]>
  operationId(): string
  now(): number
}

interface SafeSyncStatusResponse {
  capability: boolean
  state: "OFF" | "BOOTSTRAPPING" | "STRICT"
  latestVaultRevision: number
  migrationVerified: boolean
  bootstrapSessionId?: string
  bootstrapExpiresAt?: number
  uid: number
  vaultId: number
}

export interface SafeSyncManifestItem {
  resourceId: string
  resourceType: "NOTE" | "FILE" | "FOLDER"
  path: string
  state: "LIVE" | "DELETED"
  resourceRevision: number
  contentHash: string
  size: number
}

export interface SafeMirrorBootstrapSnapshot {
  sessionId: string
  manifestHash: string
  snapshotVaultRevision: number
  expiresAt: number
  remoteItems: SafeSyncManifestItem[]
}

export class SafeSyncManifestMismatchError extends Error {
  constructor(readonly mismatches: SafeSyncManifestMismatch[]) {
    super(`safe sync bootstrap found ${mismatches.length} unresolved manifest mismatch(es)`)
    this.name = "SafeSyncManifestMismatchError"
  }
}

export class SafeSyncRevisionGapError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`safe sync event revision gap: expected ${expectedRevision}, got ${actualRevision}`)
    this.name = "SafeSyncRevisionGapError"
  }
}

export class SafeSyncEngine {
  private stateStore?: SafeSyncStateStoreLike
  private identityKey = ""
  private readonly serverFingerprint: string
  private remoteEvents: SafeSyncEvent[] = []
  private readonly remoteClaims = new Map<number, SafeRemoteEventClaim>()
  private activeRemoteEvent?: SafeSyncEvent
  private mirrorBootstrap?: SafeMirrorBootstrapSnapshot

  status: SafeSyncClientStatus = { state: "disabled", serverState: "UNKNOWN", capability: false }

  constructor(private readonly options: SafeSyncEngineOptions) {
    this.serverFingerprint = createSafeSyncServerFingerprint(options.serverUrl)
  }

  get store(): SafeSyncStateStoreLike | undefined {
    return this.stateStore
  }

  async refreshStatus(localEnabled: boolean): Promise<SafeSyncClientStatus> {
    let serverState: SafeSyncClientStatus["serverState"] = "UNKNOWN"
    let capability = false
    try {
      const response = parseStatus(await this.options.transport.request("SafeSyncStatus", { vault: this.options.vault }))
      serverState = response.state
      capability = response.capability
      if (!response.capability || !response.migrationVerified) {
        return this.setStatus("unsupported", response.state, false)
      }
      await this.initializeStateStore(response.uid, response.vaultId)
      if (response.state === "STRICT" && !localEnabled) {
        return this.setStatus("strict-vault-local-disabled", response.state, true)
      }
      if (!localEnabled) return this.setStatus("disabled", response.state, true)
      if (response.state === "BOOTSTRAPPING") return this.setStatus("bootstrapping", response.state, true)
      if (response.state === "STRICT" && this.stateStore!.bootstrapComplete) {
        return this.setStatus("active", response.state, true)
      }
      return this.setStatus("activating", response.state, true)
    } catch (error) {
      return this.setStatus("error", serverState, capability, errorMessage(error))
    }
  }

  async activate(): Promise<SafeSyncClientStatus> {
    const initial = await this.refreshStatus(true)
    if (initial.state === "unsupported" || initial.state === "error") return initial
    if (initial.state === "active") return initial
    try {
      const snapshot = await this.beginMirrorBootstrap()
      const mismatches = compareManifests(await this.options.getLocalManifest(), snapshot.remoteItems)
      if (mismatches.length > 0) throw new SafeSyncManifestMismatchError(mismatches)
      return await this.commitMirrorBootstrap(snapshot)
    } catch (error) {
      await this.cancelMirrorBootstrap().catch(() => undefined)
      this.setStatus("error", "UNKNOWN", true, errorMessage(error))
      throw error
    }
  }

  async beginMirrorBootstrap(): Promise<SafeMirrorBootstrapSnapshot> {
    const initial = await this.refreshStatus(true)
    if (initial.state === "unsupported" || initial.state === "error") {
      throw new Error(initial.message || "safe sync is unavailable")
    }
    if (this.mirrorBootstrap && this.mirrorBootstrap.expiresAt > this.options.now()) return this.mirrorBootstrap
    this.setStatus("bootstrapping", initial.serverState, true)
    const started = await this.options.transport.request("SafeSyncBootstrapStart", {
      vault: this.options.vault,
      deviceId: this.requireStore().deviceId,
    })
    const snapshot: SafeMirrorBootstrapSnapshot = {
      sessionId: requiredString(started, "sessionId"),
      manifestHash: requiredString(started, "manifestHash"),
      snapshotVaultRevision: integer(started, "snapshotVaultRevision", 0),
      expiresAt: integer(started, "expiresAt", 0),
      remoteItems: [],
    }
    let cursor = requiredString(started, "cursor")
    this.mirrorBootstrap = snapshot
    do {
      const page = await this.options.transport.request("SafeSyncBootstrapPage", {
        vault: this.options.vault,
        sessionId: snapshot.sessionId,
        cursor,
        pageSize: 200,
      })
      if (requiredString(page, "sessionId") !== snapshot.sessionId || requiredString(page, "manifestHash") !== snapshot.manifestHash ||
        integer(page, "snapshotVaultRevision", 0) !== snapshot.snapshotVaultRevision) {
        throw new Error("safe sync bootstrap page does not match the active snapshot")
      }
      snapshot.remoteItems.push(...parseManifestItems(page.items))
      cursor = optionalString(page, "nextCursor")
    } while (cursor)
    return snapshot
  }

  async commitMirrorBootstrap(snapshot: SafeMirrorBootstrapSnapshot): Promise<SafeSyncClientStatus> {
    if (!this.mirrorBootstrap || this.mirrorBootstrap.sessionId !== snapshot.sessionId || snapshot.expiresAt <= this.options.now()) {
      throw new Error("safe mirror plan expired or was replaced")
    }
    const committed = parseStatus(await this.options.transport.request("SafeSyncBootstrapCommit", {
      vault: this.options.vault,
      sessionId: snapshot.sessionId,
      manifestHash: snapshot.manifestHash,
      snapshotVaultRevision: snapshot.snapshotVaultRevision,
    }))
    if (committed.state !== "STRICT") throw new Error("safe sync bootstrap commit did not enter STRICT")
    await this.requireStore().replaceBootstrapBaselines(
      snapshot.remoteItems.map((item) => ({
        path: item.path,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        resourceRevision: item.resourceRevision,
        contentHash: item.contentHash,
        vaultRevision: snapshot.snapshotVaultRevision,
        state: item.state,
        size: item.size,
      })),
      snapshot.snapshotVaultRevision,
    )
    this.mirrorBootstrap = undefined
    return this.setStatus("active", "STRICT", true)
  }

  async cancelMirrorBootstrap(localRequested = false): Promise<void> {
    const snapshot = this.mirrorBootstrap
    this.mirrorBootstrap = undefined
    if (!snapshot) return
    await this.options.transport.request("SafeSyncBootstrapCancel", { vault: this.options.vault, sessionId: snapshot.sessionId })
    await this.refreshStatus(localRequested)
  }

  localManifest(): Promise<SafeLocalManifestItem[]> {
    return this.options.getLocalManifest()
  }

  async mutate(resourceType: "NOTE" | "FILE" | "FOLDER", input: SafeMutationInput): Promise<SafeMutationAck> {
    if (this.status.state !== "active") throw new Error("safe sync mutation requires an active client")
    const store = this.requireStore()
    const baselinePath = input.previousPath || input.path
    const baseline = store.getBaseline(baselinePath)
    if (input.action === "CREATE" ? baseline?.state === "LIVE" : !baseline || baseline.state !== "LIVE") {
      throw new Error(`safe sync mutation has no usable baseline for ${baselinePath}`)
    }
    const mutationBaseline = input.action === "CREATE" ? undefined : baseline

    const operationId = this.options.operationId()
    const payload: Record<string, unknown> = {
      vault: this.options.vault,
      deviceId: store.deviceId,
      operationId,
      resourceId: mutationBaseline?.resourceId || "",
      baseRevision: mutationBaseline?.resourceRevision || 0,
      baseHash: mutationBaseline?.contentHash || "",
      expectedPathState: input.action === "CREATE" ? "ABSENT" : "PRESENT",
      action: input.action,
      path: input.path,
      pathHash: hashPath(input.path),
      previousPath: input.previousPath || "",
      previousPathHash: input.previousPath ? hashPath(input.previousPath) : "",
      content: input.content || "",
      contentHash: input.contentHash || "",
      size: input.size || 0,
      ctime: input.ctime || 0,
      mtime: input.mtime || 0,
    }
    await store.putPending({
      operationId,
      deviceId: store.deviceId,
      path: input.path,
      previousPath: input.previousPath,
      resourceId: mutationBaseline?.resourceId,
      createdAt: this.options.now(),
      expiresAt: this.options.now() + SAFE_SYNC_OPERATION_RETENTION_MS,
      status: "pending",
      payload,
    })

    const action = resourceType === "NOTE" ? "SafeNoteMutation" : resourceType === "FILE" ? "SafeFileMutation" : "SafeFolderMutation"
    const response = await this.options.transport.request(action, payload)
    const ack: SafeMutationAck = {
      operationId,
      path: input.path,
      previousPath: input.previousPath,
      resourceId: requiredString(response, "resourceId"),
      resourceRevision: positiveInteger(response, "resourceRevision"),
      contentHash: optionalString(response, "contentHash") || input.contentHash || baseline?.contentHash || "",
      vaultRevision: positiveInteger(response, "vaultRevision"),
      state: input.action === "DELETE" ? "DELETED" : "LIVE",
      size: input.size || baseline?.size || 0,
      resourceType,
    }
    await store.acknowledge(ack)
    return ack
  }

  async startFileUpload(input: SafeMutationInput, chunkSize: number): Promise<SafeFileUploadSession> {
    if (this.status.state !== "active") throw new Error("safe file upload requires an active client")
    if (input.action !== "CREATE" && input.action !== "MODIFY") throw new Error("safe file upload only supports create or modify")
    if (!input.contentHash || !Number.isSafeInteger(input.size) || (input.size || 0) < 0) throw new Error("safe file upload requires content hash and size")
    const store = this.requireStore()
    const baseline = store.getBaseline(input.path)
    if (input.action === "CREATE" ? baseline?.state === "LIVE" : !baseline || baseline.state !== "LIVE") {
      throw new Error(`safe file upload has no usable baseline for ${input.path}`)
    }
    const mutationBaseline = input.action === "CREATE" ? undefined : baseline
    const operationId = this.options.operationId()
    const payload: Record<string, unknown> = {
      vault: this.options.vault,
      deviceId: store.deviceId,
      operationId,
      resourceId: mutationBaseline?.resourceId || "",
      baseRevision: mutationBaseline?.resourceRevision || 0,
      baseHash: mutationBaseline?.contentHash || "",
      expectedPathState: input.action === "CREATE" ? "ABSENT" : "PRESENT",
      action: input.action,
      path: input.path,
      pathHash: hashPath(input.path),
      contentHash: input.contentHash,
      size: input.size || 0,
      ctime: input.ctime || 0,
      mtime: input.mtime || 0,
    }
    const now = this.options.now()
    await store.putPending({
      operationId,
      deviceId: store.deviceId,
      path: input.path,
      resourceId: mutationBaseline?.resourceId,
      createdAt: now,
      expiresAt: now + SAFE_SYNC_OPERATION_RETENTION_MS,
      status: "pending",
      payload,
    })
    const response = await this.options.transport.request("SafeFileUploadStart", { ...payload, chunkSize })
    const responseOperationID = requiredString(response, "operationId")
    if (responseOperationID !== operationId) throw new Error("safe file upload session operationId mismatch")
    return {
      sessionId: requiredString(response, "sessionId"),
      operationId,
      nextChunkIndex: integer(response, "nextChunkIndex", 0),
      expiresAt: integer(response, "expiresAt", 0),
    }
  }

  async commitFileUpload(operationId: string, sessionId: string, contentHash: string, size: number): Promise<SafeMutationAck> {
    const store = this.requireStore()
    const pending = store.getPending(operationId)
    if (!pending || pending.status !== "pending") throw new Error("safe file upload commit has no pending mutation")
    if (pending.payload.contentHash !== contentHash || pending.payload.size !== size) {
      throw new Error("safe file upload commit does not match pending content")
    }
    const response = await this.options.transport.request("SafeFileUploadCommit", {
      vault: this.options.vault,
      deviceId: store.deviceId,
      operationId,
      sessionId,
      contentHash,
      size,
    })
    const ack: SafeMutationAck = {
      operationId,
      path: pending.path,
      resourceId: requiredString(response, "resourceId"),
      resourceRevision: positiveInteger(response, "resourceRevision"),
      contentHash: optionalString(response, "contentHash") || contentHash,
      vaultRevision: positiveInteger(response, "vaultRevision"),
      state: "LIVE",
      size,
      resourceType: "FILE",
    }
    await store.acknowledge(ack)
    return ack
  }

  async pullEvents(): Promise<SafeSyncEvent[]> {
    if (this.status.state !== "active") return []
    const store = this.requireStore()
    const collected: SafeSyncEvent[] = []
    let afterRevision = store.latestVaultRevision
    let hasMore = true
    while (hasMore) {
      const response = await this.options.transport.request("SafeSyncEvents", {
        vault: this.options.vault,
        afterRevision,
        pageSize: 200,
      })
      const events = parseEvents(response.events).filter((event) => event.vaultRevision > store.latestVaultRevision)
      let expected = afterRevision + 1
      for (const event of events) {
        if (event.vaultRevision !== expected) throw new SafeSyncRevisionGapError(expected, event.vaultRevision)
        collected.push(event)
        expected++
      }
      const nextRevision = integer(response, "nextRevision", afterRevision)
      hasMore = response.hasMore === true
      if (hasMore && nextRevision <= afterRevision) throw new Error("safe sync event cursor did not advance")
      afterRevision = nextRevision
    }
    return collected
  }

  async prepareRemoteEvents(): Promise<number> {
    this.resetRemoteEvents(new Error("safe sync event queue was replaced by a new connection"))
    const events = await this.pullEvents()
    this.remoteEvents = events
    await this.advanceAcknowledgedEvents()

    const resourceCounts = new Map<string, number>()
    for (const event of this.remoteEvents) {
      const count = (resourceCounts.get(event.resourceId) || 0) + 1
      resourceCounts.set(event.resourceId, count)
      if (count > 1) {
        const error = new Error(`safe sync has multiple unapplied events for resource ${event.resourceId}; re-bootstrap is required`)
        this.failRemoteEvents(error)
        throw error
      }
    }
    return events.length
  }

  claimRemoteEvent(
    resourceType: SafeSyncEvent["resourceType"],
    action: "UPSERT" | "DELETE" | "RENAME",
    path: string,
    previousPath: string = "",
    contentHash: string = "",
  ): Promise<SafeSyncEvent> {
    if (this.status.state !== "active") return Promise.reject(new Error("safe sync remote event requires an active client"))
    const event = this.remoteEvents.find((candidate) => !this.remoteClaims.has(candidate.vaultRevision) &&
      remoteEventMatches(candidate, resourceType, action, path, previousPath, contentHash))
    if (!event) {
      const error = new Error(`no matching safe sync event for ${resourceType} ${action} ${path}`)
      this.failRemoteEvents(error)
      return Promise.reject(error)
    }

    const promise = new Promise<SafeSyncEvent>((resolve, reject) => {
      this.remoteClaims.set(event.vaultRevision, { event, released: false, resolve, reject })
    })
    this.releaseRemoteEvent()
    return promise
  }

  async commitRemoteEvent(event: SafeSyncEvent, baseline: SafeRevisionBaseline): Promise<void> {
    if (!this.activeRemoteEvent || this.activeRemoteEvent.vaultRevision !== event.vaultRevision) {
      throw new Error("safe sync remote event is not the active Vault Revision")
    }
    validateRemoteBaseline(event, baseline)
    await this.requireStore().applyRemoteBaseline(baseline, event.previousPath)
    this.remoteEvents.shift()
    this.remoteClaims.delete(event.vaultRevision)
    this.activeRemoteEvent = undefined
    await this.advanceAcknowledgedEvents()
    this.releaseRemoteEvent()
  }

  rejectRemoteEvent(event: SafeSyncEvent, reason: unknown): void {
    if (!this.activeRemoteEvent || this.activeRemoteEvent.vaultRevision !== event.vaultRevision) return
    this.failRemoteEvents(reason instanceof Error ? reason : new Error(String(reason)))
  }

  pendingRemoteEventCount(): number {
    return this.remoteEvents.length
  }

  nextRemoteEvent(): SafeSyncEvent | undefined {
    return this.remoteEvents[0]
  }

  cancelRemoteEvents(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    if (this.remoteEvents.length > 0 || this.remoteClaims.size > 0) {
      this.failRemoteEvents(error)
    } else {
      this.resetRemoteEvents(error)
    }
  }

  private async initializeStateStore(uid: number, vaultId: number): Promise<void> {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(vaultId) || vaultId <= 0) {
      throw new Error("safe sync status is missing uid or vaultId")
    }
    const key = `${uid}:${vaultId}`
    if (this.stateStore && this.identityKey === key) return
    const store = this.options.createStateStore({ serverFingerprint: this.serverFingerprint, uid, vaultId })
    await store.initialize()
    await store.expirePending(this.options.now())
    this.stateStore = store
    this.identityKey = key
  }

  private requireStore(): SafeSyncStateStoreLike {
    if (!this.stateStore) throw new Error("safe sync state store is not initialized")
    return this.stateStore
  }

  private async advanceAcknowledgedEvents(): Promise<void> {
    const store = this.requireStore()
    while (this.remoteEvents.length > 0 && remoteEventMatchesBaseline(this.remoteEvents[0], store)) {
      await store.advanceVaultRevision(this.remoteEvents[0].vaultRevision)
      this.remoteEvents.shift()
    }
  }

  private releaseRemoteEvent(): void {
    if (this.activeRemoteEvent || this.remoteEvents.length === 0) return
    const event = this.remoteEvents[0]
    const claim = this.remoteClaims.get(event.vaultRevision)
    if (!claim || claim.released) return
    try {
      validateRemoteEventPrecondition(event, this.requireStore())
      claim.released = true
      this.activeRemoteEvent = event
      claim.resolve(event)
    } catch (error) {
      this.failRemoteEvents(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private failRemoteEvents(error: Error): void {
    this.setStatus("error", this.status.serverState, this.status.capability, error.message)
    this.resetRemoteEvents(error)
  }

  private resetRemoteEvents(error: Error): void {
    for (const claim of this.remoteClaims.values()) {
      if (!claim.released) claim.reject(error)
    }
    this.remoteClaims.clear()
    this.remoteEvents = []
    this.activeRemoteEvent = undefined
  }

  private setStatus(state: SafeSyncClientState, serverState: SafeSyncClientStatus["serverState"], capability: boolean, message?: string): SafeSyncClientStatus {
    this.status = { state, serverState, capability, ...(message ? { message } : {}) }
    return this.status
  }
}

function remoteEventMatches(
  event: SafeSyncEvent,
  resourceType: SafeSyncEvent["resourceType"],
  action: "UPSERT" | "DELETE" | "RENAME",
  path: string,
  previousPath: string,
  contentHash: string,
): boolean {
  const actionMatches = action === "UPSERT"
    ? event.action === "CREATE" || event.action === "MODIFY"
    : event.action === action
  return actionMatches && event.resourceType === resourceType && event.path === path &&
    (action !== "RENAME" || event.previousPath === previousPath) &&
    (!contentHash || !event.contentHash || event.contentHash === contentHash)
}

function validateRemoteEventPrecondition(event: SafeSyncEvent, store: SafeSyncStateStoreLike): void {
  const sourcePath = event.action === "RENAME" ? event.previousPath || "" : event.path
  if (store.hasPendingForPath(sourcePath) || (event.path !== sourcePath && store.hasPendingForPath(event.path))) {
    throw new Error(`safe sync remote event conflicts with a pending local mutation at ${sourcePath || event.path}`)
  }
  if (event.action === "CREATE") {
    if (store.getBaseline(event.path)?.state === "LIVE") {
      throw new Error(`safe sync create target already has a live baseline at ${event.path}`)
    }
    return
  }
  const baseline = store.getBaseline(sourcePath)
  if (!baseline || baseline.state !== "LIVE" || baseline.resourceId !== event.resourceId) {
    throw new Error(`safe sync remote event has no matching live baseline at ${sourcePath}`)
  }
  if (event.resourceRevision !== baseline.resourceRevision + 1) {
    throw new Error(`safe sync remote event revision does not follow the baseline at ${sourcePath}`)
  }
  if (event.action === "RENAME" && store.getBaseline(event.path)?.state === "LIVE") {
    throw new Error(`safe sync rename target already has a live baseline at ${event.path}`)
  }
}

function validateRemoteBaseline(event: SafeSyncEvent, baseline: SafeRevisionBaseline): void {
  const expectedState = event.action === "DELETE" ? "DELETED" : "LIVE"
  if (baseline.path !== event.path || baseline.resourceId !== event.resourceId ||
    baseline.resourceRevision !== event.resourceRevision || baseline.vaultRevision !== event.vaultRevision ||
    baseline.state !== expectedState || (event.contentHash && baseline.contentHash !== event.contentHash)) {
    throw new Error("safe sync remote baseline does not match the active event")
  }
}

function remoteEventMatchesBaseline(event: SafeSyncEvent, store: SafeSyncStateStoreLike): boolean {
  const baseline = store.getBaseline(event.path)
  if (!baseline || baseline.resourceId !== event.resourceId || baseline.resourceRevision < event.resourceRevision) return false
  if (baseline.resourceRevision > event.resourceRevision) return true
  const expectedState = event.action === "DELETE" ? "DELETED" : "LIVE"
  return baseline.state === expectedState && (!event.contentHash || baseline.contentHash === event.contentHash)
}

function compareManifests(localItems: SafeLocalManifestItem[], remoteItems: SafeSyncManifestItem[]): SafeSyncManifestMismatch[] {
  const local = new Map(localItems.filter((item) => item.path && item.path !== "/").map((item) => [item.path, item]))
  const remote = new Map(remoteItems.filter((item) => item.path && item.path !== "/").map((item) => [item.path, item]))
  const mismatches: SafeSyncManifestMismatch[] = []
  for (const [path, remoteItem] of remote) {
    const localItem = local.get(path)
    if (remoteItem.state === "DELETED") {
      if (localItem) mismatches.push({ path, reason: "tombstone-local-exists" })
      continue
    }
    if (!localItem) {
      mismatches.push({ path, reason: "missing-local" })
    } else if (localItem.resourceType !== remoteItem.resourceType) {
      mismatches.push({ path, reason: "type-mismatch" })
    } else if (localItem.contentHash !== remoteItem.contentHash || localItem.size !== remoteItem.size) {
      mismatches.push({ path, reason: "content-mismatch" })
    }
  }
  for (const path of local.keys()) {
    if (!remote.has(path)) mismatches.push({ path, reason: "local-only" })
  }
  return mismatches.sort((left, right) => left.path.localeCompare(right.path))
}

function parseStatus(value: Record<string, unknown>): SafeSyncStatusResponse {
  const state = value.state
  if (state !== "OFF" && state !== "BOOTSTRAPPING" && state !== "STRICT") throw new Error("invalid safe sync server state")
  return {
    capability: value.capability === true,
    state,
    latestVaultRevision: integer(value, "latestVaultRevision", 0),
    migrationVerified: value.migrationVerified === true,
    bootstrapSessionId: optionalString(value, "bootstrapSessionId"),
    bootstrapExpiresAt: integer(value, "bootstrapExpiresAt", 0),
    uid: integer(value, "uid", 0),
    vaultId: integer(value, "vaultId", 0),
  }
}

function parseManifestItems(value: unknown): SafeSyncManifestItem[] {
  if (!Array.isArray(value)) throw new Error("invalid safe sync manifest page")
  return value.map((item) => {
    const record = asRecord(item)
    const resourceType = parseResourceType(record.resourceType)
    const state = record.state === "DELETED" ? "DELETED" : record.state === "LIVE" ? "LIVE" : undefined
    if (!state) throw new Error("invalid safe sync manifest resource state")
    return {
      resourceId: requiredString(record, "resourceId"),
      resourceType,
      path: requiredString(record, "path"),
      state,
      resourceRevision: positiveInteger(record, "resourceRevision"),
      contentHash: optionalString(record, "contentHash"),
      size: integer(record, "size", 0),
    }
  })
}

function parseEvents(value: unknown): SafeSyncEvent[] {
  if (!Array.isArray(value)) throw new Error("invalid safe sync events response")
  return value.map((item) => {
    const record = asRecord(item)
    const action = record.action
    if (action !== "CREATE" && action !== "MODIFY" && action !== "DELETE" && action !== "RENAME") {
      throw new Error("invalid safe sync event action")
    }
    return {
      vaultRevision: positiveInteger(record, "vaultRevision"),
      resourceId: requiredString(record, "resourceId"),
      resourceRevision: positiveInteger(record, "resourceRevision"),
      resourceType: parseResourceType(record.resourceType),
      action,
      path: requiredString(record, "path"),
      previousPath: optionalString(record, "previousPath") || undefined,
      contentHash: optionalString(record, "contentHash"),
      state: record.state === "DELETED" ? "DELETED" : "LIVE",
      transactionId: optionalString(record, "transactionId") || undefined,
      operationId: optionalString(record, "operationId") || undefined,
    }
  })
}

function parseResourceType(value: unknown): "NOTE" | "FILE" | "FOLDER" {
  if (value === "NOTE" || value === "FILE" || value === "FOLDER") return value
  throw new Error("invalid safe sync resource type")
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object")
  return value as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value, key)
  if (!result) throw new Error(`safe sync response is missing ${key}`)
  return result
}

function optionalString(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : ""
}

function integer(value: Record<string, unknown>, key: string, fallback: number): number {
  const result = Number(value[key])
  return Number.isSafeInteger(result) && result >= 0 ? result : fallback
}

function positiveInteger(value: Record<string, unknown>, key: string): number {
  const result = integer(value, key, 0)
  if (result <= 0) throw new Error(`safe sync response has invalid ${key}`)
  return result
}

function hashPath(path: string): string {
  let hash = 0
  for (let index = 0; index < path.length; index++) hash = ((hash << 5) - hash + path.charCodeAt(index)) | 0
  return String(hash)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
