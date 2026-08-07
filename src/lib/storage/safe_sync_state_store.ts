export const SAFE_SYNC_OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export type SafeSyncResourceState = "LIVE" | "DELETED"
export type SafePendingStatus = "pending" | "expired"

export interface SafeRevisionBaseline {
  path: string
  resourceId: string
  resourceRevision: number
  contentHash: string
  vaultRevision: number
  state: SafeSyncResourceState
  size: number
}

export interface SafePendingMutation {
  operationId: string
  deviceId: string
  path: string
  previousPath?: string
  resourceId?: string
  createdAt: number
  expiresAt: number
  status: SafePendingStatus
  payload: Record<string, unknown>
}

export interface SafeMutationAck {
  operationId: string
  path: string
  previousPath?: string
  resourceId: string
  resourceRevision: number
  contentHash: string
  vaultRevision: number
  state?: SafeSyncResourceState
  size?: number
}

interface SafeSyncStateDocument {
  version: 1
  namespace: string
  generation: number
  deviceId: string
  bootstrapComplete: boolean
  latestVaultRevision: number
  baselines: Record<string, SafeRevisionBaseline>
  pending: Record<string, SafePendingMutation>
}

export interface SafeSyncStateAdapter {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  remove(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export interface SafeSyncStateHost {
  app: {
    loadLocalStorage(key: string): unknown
    saveLocalStorage(key: string, value: string): void
    vault: {
      configDir: string
      adapter: SafeSyncStateAdapter
    }
  }
  manifest: { id: string; dir?: string }
}

export class SafeSyncStateCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SafeSyncStateCorruptError"
  }
}

export function createSafeSyncServerFingerprint(serverUrl: string): string {
  const normalized = serverUrl.trim().replace(/\/+$/, "").toLowerCase()
  let hash = 2166136261
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function createSafeSyncNamespace(serverFingerprint: string, uid: number, vaultId: number): string {
  const fingerprint = serverFingerprint.trim().replace(/[^a-zA-Z0-9_-]/g, "_")
  if (!fingerprint || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(vaultId) || vaultId <= 0) {
    throw new Error("safe sync namespace requires server fingerprint, uid, and vault id")
  }
  return `${fingerprint}-u${uid}-v${vaultId}`
}

export class SafeSyncStateStore {
  private readonly adapter: SafeSyncStateAdapter
  private readonly localStorageKey: string
  private readonly statePath: string
  private state: SafeSyncStateDocument

  constructor(private readonly host: SafeSyncStateHost, readonly namespace: string, deviceId: string) {
    if (!namespace || !deviceId.trim()) throw new Error("safe sync namespace and device id are required")
    this.adapter = host.app.vault.adapter
    this.localStorageKey = `fns-safe-sync-${namespace}`
    const pluginDir = resolvePluginDir(host)
    this.statePath = `${pluginDir}/safe-sync/state-${namespace}.json`
    this.state = emptySafeSyncState(namespace, deviceId)
  }

  async initialize(): Promise<void> {
    const local = this.readLocalCandidate()
    const file = await this.readFileCandidate()
    if (local.corrupt && file.corrupt) {
      throw new SafeSyncStateCorruptError("safe sync state is corrupt in local storage and file mirror")
    }
    const candidates = [local.value, file.value].filter((value): value is SafeSyncStateDocument => value != null)
    if (candidates.length > 0) {
      candidates.sort((left, right) => right.generation - left.generation)
      this.state = candidates[0]
      await this.persist(false)
    }
  }

  get deviceId(): string {
    return this.state.deviceId
  }

  get latestVaultRevision(): number {
    return this.state.latestVaultRevision
  }

  get bootstrapComplete(): boolean {
    return this.state.bootstrapComplete
  }

  getBaseline(path: string): SafeRevisionBaseline | undefined {
    const baseline = this.state.baselines[path]
    return baseline ? { ...baseline } : undefined
  }

  listBaselines(): SafeRevisionBaseline[] {
    return Object.values(this.state.baselines).map((baseline) => ({ ...baseline }))
  }

  getPending(operationId: string): SafePendingMutation | undefined {
    const pending = this.state.pending[operationId]
    return pending ? clonePending(pending) : undefined
  }

  hasPendingForPath(path: string): boolean {
    return Object.values(this.state.pending).some((pending) => pending.status === "pending" && (pending.path === path || pending.previousPath === path))
  }

  async replaceBootstrapBaselines(baselines: SafeRevisionBaseline[], latestVaultRevision: number): Promise<void> {
    const next: Record<string, SafeRevisionBaseline> = {}
    for (const baseline of baselines) {
      validateBaseline(baseline)
      next[baseline.path] = { ...baseline }
    }
    this.state.baselines = next
    this.state.latestVaultRevision = latestVaultRevision
    this.state.bootstrapComplete = true
    await this.persist()
  }

  async putPending(pending: SafePendingMutation): Promise<void> {
    validatePending(pending)
    const existing = this.state.pending[pending.operationId]
    if (existing && JSON.stringify(existing) !== JSON.stringify(pending)) {
      throw new Error("operation id is already bound to a different pending mutation")
    }
    this.state.pending[pending.operationId] = clonePending(pending)
    await this.persist()
  }

  async acknowledge(ack: SafeMutationAck): Promise<void> {
    const pending = this.state.pending[ack.operationId]
    if (!pending || pending.status !== "pending") throw new Error("safe sync ack has no matching pending mutation")
    if (pending.path !== ack.path || (pending.resourceId && pending.resourceId !== ack.resourceId)) {
      throw new Error("safe sync ack does not match pending resource")
    }
    if (ack.previousPath) delete this.state.baselines[ack.previousPath]
    this.state.baselines[ack.path] = {
      path: ack.path,
      resourceId: ack.resourceId,
      resourceRevision: ack.resourceRevision,
      contentHash: ack.contentHash,
      vaultRevision: ack.vaultRevision,
      state: ack.state || "LIVE",
      size: ack.size || 0,
    }
    if (ack.vaultRevision === this.state.latestVaultRevision + 1) {
      this.state.latestVaultRevision = ack.vaultRevision
    }
    delete this.state.pending[ack.operationId]
    await this.persist()
  }

  async applyRemoteBaseline(baseline: SafeRevisionBaseline, previousPath?: string): Promise<void> {
    validateBaseline(baseline)
    if (baseline.vaultRevision !== this.state.latestVaultRevision + 1) {
      throw new Error("safe sync remote baseline must advance the Vault Revision contiguously")
    }
    if (previousPath && previousPath !== baseline.path) delete this.state.baselines[previousPath]
    this.state.baselines[baseline.path] = { ...baseline }
    this.state.latestVaultRevision = baseline.vaultRevision
    await this.persist()
  }

  async advanceVaultRevision(vaultRevision: number): Promise<void> {
    if (vaultRevision !== this.state.latestVaultRevision + 1) {
      throw new Error("safe sync event cursor must advance contiguously")
    }
    this.state.latestVaultRevision = vaultRevision
    await this.persist()
  }

  async expirePending(now: number = Date.now()): Promise<SafePendingMutation[]> {
    const expired: SafePendingMutation[] = []
    let changed = false
    for (const pending of Object.values(this.state.pending)) {
      if (pending.status === "pending" && pending.expiresAt <= now) {
        pending.status = "expired"
        expired.push(clonePending(pending))
        changed = true
      }
    }
    if (changed) await this.persist()
    return expired
  }

  listRetryablePending(now: number = Date.now()): SafePendingMutation[] {
    return Object.values(this.state.pending)
      .filter((pending) => pending.status === "pending" && pending.expiresAt > now)
      .map(clonePending)
  }

  private readLocalCandidate(): { value?: SafeSyncStateDocument; corrupt: boolean } {
	const raw = this.host.app.loadLocalStorage(this.localStorageKey)
	if (raw == null || raw === "") return { corrupt: false }
	if (typeof raw !== "string") return { corrupt: true }
	try {
	  return { value: parseState(raw, this.namespace), corrupt: false }
    } catch {
      return { corrupt: true }
    }
  }

  private async readFileCandidate(): Promise<{ value?: SafeSyncStateDocument; corrupt: boolean }> {
    if (!(await this.adapter.exists(this.statePath))) return { corrupt: false }
    try {
      return { value: parseState(await this.adapter.read(this.statePath), this.namespace), corrupt: false }
    } catch {
      return { corrupt: true }
    }
  }

  private async persist(incrementGeneration: boolean = true): Promise<void> {
    if (incrementGeneration) this.state.generation++
    const serialized = JSON.stringify(this.state)
    await atomicWriteText(this.adapter, this.statePath, serialized)
    try {
      this.host.app.saveLocalStorage(this.localStorageKey, serialized)
    } catch {
      // The file mirror remains authoritative when mobile localStorage is evicted or full.
    }
  }
}

function emptySafeSyncState(namespace: string, deviceId: string): SafeSyncStateDocument {
  return { version: 1, namespace, generation: 0, deviceId, bootstrapComplete: false, latestVaultRevision: 0, baselines: {}, pending: {} }
}

function parseState(raw: string, namespace: string): SafeSyncStateDocument {
  const value = JSON.parse(raw) as Partial<SafeSyncStateDocument>
  if (value.version !== 1 || value.namespace !== namespace || !Number.isSafeInteger(value.generation) ||
    typeof value.deviceId !== "string" || !value.deviceId || !Number.isSafeInteger(value.latestVaultRevision) ||
    !isRecord(value.baselines) || !isRecord(value.pending)) {
    throw new SafeSyncStateCorruptError("invalid safe sync state document")
  }
	for (const baseline of Object.values(value.baselines)) validateBaseline(baseline)
	for (const pending of Object.values(value.pending)) validatePending(pending)
  const bootstrapComplete = typeof value.bootstrapComplete === "boolean"
    ? value.bootstrapComplete
    : Object.keys(value.baselines).length > 0 || Number(value.latestVaultRevision) > 0
  return { ...value, bootstrapComplete } as SafeSyncStateDocument
}

function validateBaseline(value: SafeRevisionBaseline): void {
  if (!value || typeof value.path !== "string" || !value.path || typeof value.resourceId !== "string" || !value.resourceId ||
    !Number.isSafeInteger(value.resourceRevision) || value.resourceRevision <= 0 || !Number.isSafeInteger(value.vaultRevision) || value.vaultRevision < 0 ||
    typeof value.contentHash !== "string" || (value.state !== "LIVE" && value.state !== "DELETED") || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new SafeSyncStateCorruptError("invalid safe sync baseline")
  }
}

function validatePending(value: SafePendingMutation): void {
  if (!value || typeof value.operationId !== "string" || !value.operationId || typeof value.deviceId !== "string" || !value.deviceId ||
    typeof value.path !== "string" || !value.path || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= value.createdAt || (value.status !== "pending" && value.status !== "expired") || !isRecord(value.payload)) {
    throw new SafeSyncStateCorruptError("invalid safe sync pending mutation")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function clonePending(pending: SafePendingMutation): SafePendingMutation {
  return { ...pending, payload: { ...pending.payload } }
}

function resolvePluginDir(host: SafeSyncStateHost): string {
  const configured = host.manifest.dir?.replace(/\\/g, "/")
  if (configured) return configured
  return `${host.app.vault.configDir.replace(/\\/g, "/")}/plugins/${host.manifest.id}`
}

async function atomicWriteText(adapter: SafeSyncStateAdapter, path: string, data: string): Promise<void> {
  await ensureDirectory(adapter, path.substring(0, path.lastIndexOf("/")))
  const tempPath = `${path}.tmp`
  const backupPath = `${path}.bak`
  if (await adapter.exists(tempPath)) await adapter.remove(tempPath)
  if (await adapter.exists(backupPath)) await adapter.remove(backupPath)
  await adapter.write(tempPath, data)
  const hadCurrent = await adapter.exists(path)
  if (hadCurrent) await adapter.rename(path, backupPath)
  try {
    await adapter.rename(tempPath, path)
    if (hadCurrent && await adapter.exists(backupPath)) await adapter.remove(backupPath)
  } catch (error) {
    if (hadCurrent && await adapter.exists(backupPath) && !(await adapter.exists(path))) {
      await adapter.rename(backupPath, path)
    }
    throw error
  }
}

export async function ensureDirectory(adapter: Pick<SafeSyncStateAdapter, "exists" | "mkdir">, path: string): Promise<void> {
  if (!path) return
  const parts = path.split("/").filter(Boolean)
  let current = ""
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    if (!(await adapter.exists(current))) await adapter.mkdir(current)
  }
}
