import assert from "node:assert/strict"
import path from "node:path"
import esbuild from "esbuild"

const root = path.resolve(import.meta.dirname, "..")
const build = await esbuild.build({
  entryPoints: [path.join(root, "src", "lib", "sync", "safe_sync_engine.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2020",
  write: false,
})
const source = Buffer.from(build.outputFiles[0].contents).toString("base64")
const { SafeSyncEngine, SafeSyncManifestMismatchError, SafeSyncRevisionGapError } =
  await import(`data:text/javascript;base64,${source}`)

class MemoryStore {
  constructor() {
    this.deviceId = "device-a"
    this.latestVaultRevision = 0
    this.persistedBootstrapComplete = false
    this.baselines = new Map()
    this.pending = new Map()
  }

  get bootstrapComplete() {
    return this.persistedBootstrapComplete || this.baselines.size > 0 || this.latestVaultRevision > 0
  }

  async initialize() {}
  async expirePending() { return [] }
  listBaselines() { return [...this.baselines.values()].map((item) => ({ ...item })) }
  getBaseline(path) { return this.baselines.get(path) }
  getPending(operationId) { return this.pending.get(operationId) }
  hasPendingForPath(path) {
    return [...this.pending.values()].some((pending) => pending.status === "pending" &&
      (pending.path === path || pending.previousPath === path))
  }
  listRetryablePending() { return [...this.pending.values()] }
  async replaceBootstrapBaselines(items, revision) {
    this.baselines = new Map(items.map((item) => [item.path, { ...item }]))
    this.latestVaultRevision = revision
    this.persistedBootstrapComplete = true
  }
  async putPending(pending) { this.pending.set(pending.operationId, pending) }
  async removePending(operationId) { this.pending.delete(operationId) }
  async acknowledge(ack) {
    const pending = this.pending.get(ack.operationId)
    if (!pending) throw new Error("missing pending")
    if (ack.previousPath) this.baselines.delete(ack.previousPath)
    this.baselines.set(ack.path, { ...ack, state: ack.state || "LIVE", size: ack.size || 0 })
    if (ack.vaultRevision === this.latestVaultRevision + 1) this.latestVaultRevision = ack.vaultRevision
    this.pending.delete(ack.operationId)
  }
  async applyRemoteBaseline(baseline, previousPath) {
    if (baseline.vaultRevision !== this.latestVaultRevision + 1) throw new Error("remote baseline revision is not contiguous")
    if (previousPath) this.baselines.delete(previousPath)
    this.baselines.set(baseline.path, { ...baseline })
    this.latestVaultRevision = baseline.vaultRevision
  }
  async advanceVaultRevision(revision) {
    if (revision !== this.latestVaultRevision + 1) throw new Error("event cursor is not contiguous")
    this.latestVaultRevision = revision
  }
}

class ScriptedTransport {
  constructor(script) {
    this.script = new Map(Object.entries(script))
    this.calls = []
  }

  async request(action, payload) {
    this.calls.push({ action, payload })
    const queue = this.script.get(action) || []
    if (queue.length === 0) throw new Error(`unexpected request: ${action}`)
    const next = queue.shift()
    if (next instanceof Error) throw next
    return structuredClone(next)
  }
}

const unsupported = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({ SafeSyncStatus: [{ capability: false, state: "OFF" }] }),
  createStateStore: () => { throw new Error("unsupported status must not create state") },
  getLocalManifest: async () => [],
  operationId: () => "op-a",
  now: () => 1_000,
})
assert.equal((await unsupported.refreshStatus(false)).state, "unsupported")

const disabledStore = new MemoryStore()
const disabled = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({
    SafeSyncStatus: [{ capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
  }),
  createStateStore: () => disabledStore,
  getLocalManifest: async () => [],
  operationId: () => "op-disabled",
  now: () => 1_000,
})
assert.equal((await disabled.refreshStatus(false)).state, "disabled")

const activatingStore = new MemoryStore()
const activating = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({
    SafeSyncStatus: [{ capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
  }),
  createStateStore: () => activatingStore,
  getLocalManifest: async () => [],
  operationId: () => "op-activating",
  now: () => 1_000,
})
assert.equal((await activating.refreshStatus(true)).state, "activating")

const bootstrappingStore = new MemoryStore()
const bootstrapping = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({
    SafeSyncStatus: [{ capability: true, state: "BOOTSTRAPPING", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
  }),
  createStateStore: () => bootstrappingStore,
  getLocalManifest: async () => [],
  operationId: () => "op-bootstrapping",
  now: () => 1_000,
})
assert.equal((await bootstrapping.refreshStatus(true)).state, "bootstrapping")

const errored = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({ SafeSyncStatus: [new Error("status unavailable")] }),
  createStateStore: () => { throw new Error("error status must not create state") },
  getLocalManifest: async () => [],
  operationId: () => "op-error",
  now: () => 1_000,
})
assert.equal((await errored.refreshStatus(true)).state, "error")

const strictStore = new MemoryStore()
const strictDisabled = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({
    SafeSyncStatus: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
  }),
  createStateStore: () => strictStore,
  getLocalManifest: async () => [],
  operationId: () => "op-a",
  now: () => 1_000,
})
assert.equal((await strictDisabled.refreshStatus(false)).state, "strict-vault-local-disabled")

const emptyStore = new MemoryStore()
const emptyTransport = new ScriptedTransport({
  SafeSyncStatus: [
    { capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
    { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
    { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
  ],
  SafeSyncBootstrapStart: [{ state: "BOOTSTRAPPING", sessionId: "session-empty", expiresAt: 20_000, snapshotVaultRevision: 0, manifestHash: "manifest-empty", cursor: "cursor-empty" }],
  SafeSyncBootstrapPage: [{ sessionId: "session-empty", snapshotVaultRevision: 0, manifestHash: "manifest-empty", items: [], nextCursor: "" }],
  SafeSyncBootstrapCommit: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
})
const emptyVault = new SafeSyncEngine({
  vault: "empty-vault",
  serverUrl: "https://sync.example.com",
  transport: emptyTransport,
  createStateStore: () => emptyStore,
  getLocalManifest: async () => [],
  operationId: () => "op-empty",
  now: () => 1_000,
})
assert.equal((await emptyVault.activate()).state, "active")
assert.equal((await emptyVault.refreshStatus(true)).state, "active", "an empty bootstrapped Vault must remain active after reconnect")
assert.equal(emptyTransport.calls.filter((call) => call.action === "SafeSyncBootstrapStart").length, 1)

const rootOnlyStore = new MemoryStore()
const rootOnlyTransport = new ScriptedTransport({
  SafeSyncStatus: [
    { capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
    { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
  ],
  SafeSyncBootstrapStart: [{ state: "BOOTSTRAPPING", sessionId: "session-root", expiresAt: 20_000, snapshotVaultRevision: 0, manifestHash: "manifest-root", cursor: "cursor-root" }],
  SafeSyncBootstrapPage: [{ sessionId: "session-root", snapshotVaultRevision: 0, manifestHash: "manifest-root", items: [], nextCursor: "" }],
  SafeSyncBootstrapCommit: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
})
const rootOnlyVault = new SafeSyncEngine({
  vault: "root-only-vault",
  serverUrl: "https://sync.example.com",
  transport: rootOnlyTransport,
  createStateStore: () => rootOnlyStore,
  getLocalManifest: async () => [{ resourceType: "FOLDER", path: "/", contentHash: "", size: 0 }],
  operationId: () => "op-root",
  now: () => 1_000,
})
assert.equal((await rootOnlyVault.activate()).state, "active", "the Vault root must not cause a manifest mismatch")

const cancelStore = new MemoryStore()
cancelStore.persistedBootstrapComplete = true
const cancelTransport = new ScriptedTransport({
  SafeSyncStatus: [
    { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
    { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
  ],
  SafeSyncBootstrapStart: [{ state: "BOOTSTRAPPING", sessionId: "session-cancel", expiresAt: 20_000, snapshotVaultRevision: 0, manifestHash: "manifest-cancel", cursor: "cursor-cancel" }],
  SafeSyncBootstrapPage: [{ sessionId: "session-cancel", snapshotVaultRevision: 0, manifestHash: "manifest-cancel", items: [], nextCursor: "" }],
  SafeSyncBootstrapCancel: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
})
const cancelPreview = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: cancelTransport,
  createStateStore: () => cancelStore,
  getLocalManifest: async () => [],
  operationId: () => "op-cancel",
  now: () => 1_000,
})
await cancelPreview.beginMirrorBootstrap()
assert.equal(cancelPreview.status.state, "bootstrapping")
await cancelPreview.cancelMirrorBootstrap(true)
assert.equal(cancelPreview.status.state, "active", "closing a mirror preview must preserve the enabled local preference")

const refreshOnlyStore = new MemoryStore()
refreshOnlyStore.persistedBootstrapComplete = true
const refreshOnlyTransport = new ScriptedTransport({
  SafeSyncStatus: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
})
const refreshOnlyCancel = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: refreshOnlyTransport,
  createStateStore: () => refreshOnlyStore,
  getLocalManifest: async () => [],
  operationId: () => "op-refresh-only",
  now: () => 1_000,
})
await refreshOnlyCancel.cancelMirrorBootstrap(true)
assert.equal(refreshOnlyCancel.status.state, "active", "cancel without a local session must still refresh stale bootstrap status")

const retryCancelStore = new MemoryStore()
retryCancelStore.persistedBootstrapComplete = true
const retryCancelTransport = new ScriptedTransport({
  SafeSyncStatus: [
    { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
    { capability: true, state: "BOOTSTRAPPING", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
    new Error("status unavailable"),
    { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
  ],
  SafeSyncBootstrapStart: [{ state: "BOOTSTRAPPING", sessionId: "session-retry-cancel", expiresAt: 20_000, snapshotVaultRevision: 0, manifestHash: "manifest-retry-cancel", cursor: "cursor-retry-cancel" }],
  SafeSyncBootstrapPage: [{ sessionId: "session-retry-cancel", snapshotVaultRevision: 0, manifestHash: "manifest-retry-cancel", items: [], nextCursor: "" }],
  SafeSyncBootstrapCancel: [
    new Error("cancel response unavailable"),
    new Error("cancel response unavailable again"),
    { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
  ],
})
const retryCancel = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: retryCancelTransport,
  createStateStore: () => retryCancelStore,
  getLocalManifest: async () => [],
  operationId: () => "op-retry-cancel",
  now: () => 1_000,
})
await retryCancel.beginMirrorBootstrap()
await assert.rejects(() => retryCancel.cancelMirrorBootstrap(true), /cancel response unavailable/)
assert.equal(retryCancel.status.state, "bootstrapping")
await assert.rejects(() => retryCancel.cancelMirrorBootstrap(true), /cancel response unavailable again/)
assert.equal(retryCancel.status.state, "error")
await retryCancel.cancelMirrorBootstrap(true)
assert.equal(retryCancel.status.state, "active", "a failed cancel response must preserve the session for retry")
assert.equal(retryCancelTransport.calls.filter((call) => call.action === "SafeSyncBootstrapCancel").length, 3)

const failedPageStore = new MemoryStore()
const failedPageTransport = new ScriptedTransport({
  SafeSyncStatus: [
    { capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
    { capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
  ],
  SafeSyncBootstrapStart: [{ state: "BOOTSTRAPPING", sessionId: "session-failed-page", expiresAt: 20_000, snapshotVaultRevision: 0, manifestHash: "manifest-failed-page", cursor: "cursor-failed-page" }],
  SafeSyncBootstrapPage: [new Error("page unavailable")],
  SafeSyncBootstrapCancel: [{ capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
})
const failedPage = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: failedPageTransport,
  createStateStore: () => failedPageStore,
  getLocalManifest: async () => [],
  operationId: () => "op-failed-page",
  now: () => 1_000,
})
await assert.rejects(() => failedPage.activate(), /page unavailable/)
assert.equal(
  failedPageTransport.calls.filter((call) => call.action === "SafeSyncBootstrapCancel").length,
  1,
  "a failed manifest page must cancel its server bootstrap session",
)

const activeStore = new MemoryStore()
const activeOperationIds = ["op-a", "op-file"]
const activeTransport = new ScriptedTransport({
  SafeSyncStatus: [
    { capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
    { capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
  ],
  SafeSyncBootstrapStart: [{ state: "BOOTSTRAPPING", sessionId: "session-a", expiresAt: 20_000, snapshotVaultRevision: 0, manifestHash: "manifest-a", cursor: "cursor-a" }],
  SafeSyncBootstrapPage: [{
    sessionId: "session-a",
    snapshotVaultRevision: 0,
    manifestHash: "manifest-a",
    items: [{ resourceId: "r1", resourceType: "NOTE", path: "a.md", state: "LIVE", resourceRevision: 1, contentHash: "hash-a", size: 5 }],
    nextCursor: "",
  }],
  SafeSyncBootstrapCommit: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
  SafeNoteMutation: [{ resourceId: "r1", resourceRevision: 2, vaultRevision: 1, contentHash: "hash-b", outcome: "COMMITTED" }],
  SafeFileUploadStart: [{ sessionId: "upload-a", nextChunkIndex: 0, operationId: "op-file", expiresAt: 50_000 }],
  SafeFileUploadCommit: [{ resourceId: "rf", resourceRevision: 1, vaultRevision: 2, contentHash: "hash-file", outcome: "COMMITTED" }],
  SafeSyncEvents: [{
    events: [{ vaultRevision: 3, resourceId: "r2", resourceRevision: 1, resourceType: "NOTE", action: "CREATE", path: "b.md", contentHash: "hash-c", state: "LIVE" }],
    latestVaultRevision: 3,
    nextRevision: 3,
    hasMore: false,
  }],
})
const active = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: activeTransport,
  createStateStore: () => activeStore,
  getLocalManifest: async () => [{ resourceType: "NOTE", path: "a.md", contentHash: "hash-a", size: 5 }],
  operationId: () => activeOperationIds.shift(),
  now: () => 1_000,
})
assert.equal((await active.activate()).state, "active")
assert.equal(activeStore.getBaseline("a.md").resourceId, "r1")
await active.mutate("NOTE", { action: "MODIFY", path: "a.md", content: "changed", contentHash: "hash-b", size: 7, ctime: 1, mtime: 2 })
assert.equal(activeTransport.calls.find((call) => call.action === "SafeNoteMutation").payload.expectedPathState, "PRESENT")
assert.equal(activeStore.getBaseline("a.md").resourceRevision, 2)
assert.equal(activeStore.pending.size, 0)

const failedMutationStore = new MemoryStore()
failedMutationStore.baselines.set("failed.md", {
  path: "failed.md", resourceType: "NOTE", resourceId: "failed", resourceRevision: 1,
  contentHash: "before", vaultRevision: 0, state: "LIVE", size: 6,
})
const failedMutation = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({
    SafeSyncStatus: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
    SafeNoteMutation: [new Error("mutation rejected")],
  }),
  createStateStore: () => failedMutationStore,
  getLocalManifest: async () => [],
  operationId: () => "op-failed",
  now: () => 1_000,
})
assert.equal((await failedMutation.refreshStatus(true)).state, "active")
await assert.rejects(() => failedMutation.mutate("NOTE", {
  action: "MODIFY", path: "failed.md", content: "after", contentHash: "after", size: 5,
}), /mutation rejected/)
assert.equal(failedMutationStore.pending.size, 0, "a rejected mutation must not leave a stale pending operation")
const upload = await active.startFileUpload({ action: "CREATE", path: "asset.bin", contentHash: "hash-file", size: 4, ctime: 1, mtime: 2 }, 1024)
assert.equal(activeTransport.calls.find((call) => call.action === "SafeFileUploadStart").payload.expectedPathState, "ABSENT")
assert.equal(upload.sessionId, "upload-a")
assert.equal(activeStore.getPending("op-file").path, "asset.bin")
await active.commitFileUpload(upload.operationId, upload.sessionId, "hash-file", 4)
assert.equal(activeStore.getBaseline("asset.bin").resourceId, "rf")
const remoteEvents = await active.pullEvents()
assert.equal(remoteEvents.length, 1)
assert.equal(remoteEvents[0].path, "b.md")

const mismatchStore = new MemoryStore()
const mismatchTransport = new ScriptedTransport({
  SafeSyncStatus: [
    { capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
    { capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
    { capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true },
  ],
  SafeSyncBootstrapStart: [{ state: "BOOTSTRAPPING", sessionId: "session-b", expiresAt: 20_000, snapshotVaultRevision: 0, manifestHash: "manifest-b", cursor: "cursor-b" }],
  SafeSyncBootstrapPage: [{ sessionId: "session-b", snapshotVaultRevision: 0, manifestHash: "manifest-b", items: [], nextCursor: "" }],
  SafeSyncBootstrapCancel: [{ capability: true, state: "OFF", uid: 3, vaultId: 9, latestVaultRevision: 0, migrationVerified: true }],
})
const mismatch = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: mismatchTransport,
  createStateStore: () => mismatchStore,
  getLocalManifest: async () => [{ resourceType: "NOTE", path: "local-only.md", contentHash: "hash-local", size: 1 }],
  operationId: () => "op-b",
  now: () => 1_000,
})
await assert.rejects(() => mismatch.activate(), (error) => {
  assert.ok(error instanceof SafeSyncManifestMismatchError)
  assert.equal(error.mismatches[0].reason, "local-only")
  return true
})
assert.equal(mismatch.status.state, "error")
assert.equal(mismatchStore.listBaselines().length, 0)
assert.ok(mismatchTransport.calls.some((call) => call.action === "SafeSyncBootstrapCancel"))

const gapStore = new MemoryStore()
gapStore.latestVaultRevision = 4
const gap = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({
    SafeSyncStatus: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 6, migrationVerified: true }],
    SafeSyncEvents: [{
      events: [{ vaultRevision: 6, resourceId: "r6", resourceRevision: 1, resourceType: "NOTE", action: "CREATE", path: "six.md", contentHash: "h6", state: "LIVE" }],
      latestVaultRevision: 6,
      nextRevision: 6,
      hasMore: false,
    }],
  }),
  createStateStore: () => gapStore,
  getLocalManifest: async () => [],
  operationId: () => "op-gap",
  now: () => 1_000,
})
gapStore.baselines.set("seed.md", { path: "seed.md", resourceId: "seed", resourceRevision: 1, contentHash: "seed", vaultRevision: 4, state: "LIVE", size: 1 })
assert.equal((await gap.refreshStatus(true)).state, "active")
await assert.rejects(() => gap.pullEvents(), (error) => error instanceof SafeSyncRevisionGapError)

const orderedStore = new MemoryStore()
orderedStore.baselines.set("a.md", {
  path: "a.md", resourceId: "ordered-a", resourceRevision: 1, contentHash: "a1", vaultRevision: 0, state: "LIVE", size: 2,
})
orderedStore.baselines.set("b.md", {
  path: "b.md", resourceId: "ordered-b", resourceRevision: 1, contentHash: "b1", vaultRevision: 0, state: "LIVE", size: 2,
})
const ordered = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({
    SafeSyncStatus: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 2, migrationVerified: true }],
    SafeSyncEvents: [{
      events: [
        { vaultRevision: 1, resourceId: "ordered-a", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "a.md", contentHash: "a2", state: "LIVE" },
        { vaultRevision: 2, resourceId: "ordered-b", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "b.md", contentHash: "b2", state: "LIVE" },
      ],
      latestVaultRevision: 2,
      nextRevision: 2,
      hasMore: false,
    }],
  }),
  createStateStore: () => orderedStore,
  getLocalManifest: async () => [],
  operationId: () => "op-ordered",
  now: () => 1_000,
})
assert.equal((await ordered.refreshStatus(true)).state, "active")
assert.equal(await ordered.prepareRemoteEvents(), 2)
let secondReleased = false
const second = ordered.claimRemoteEvent("NOTE", "UPSERT", "b.md", "", "b2").then((event) => {
  secondReleased = true
  return event
})
await Promise.resolve()
assert.equal(secondReleased, false, "a later Vault Revision must wait for the queue head")
const first = await ordered.claimRemoteEvent("NOTE", "UPSERT", "a.md", "", "a2")
await ordered.commitRemoteEvent(first, {
  path: "a.md", resourceId: "ordered-a", resourceRevision: 2, contentHash: "a2", vaultRevision: 1, state: "LIVE", size: 2,
})
const releasedSecond = await second
await ordered.commitRemoteEvent(releasedSecond, {
  path: "b.md", resourceId: "ordered-b", resourceRevision: 2, contentHash: "b2", vaultRevision: 2, state: "LIVE", size: 2,
})
assert.equal(orderedStore.latestVaultRevision, 2)
await assert.rejects(
  () => ordered.claimRemoteEvent("NOTE", "UPSERT", "unmatched.md", "", "missing"),
  /no matching safe sync event/,
)

const repeatedStore = new MemoryStore()
repeatedStore.baselines.set("repeat.md", {
  path: "repeat.md", resourceId: "repeat", resourceRevision: 1, contentHash: "r1", vaultRevision: 0, state: "LIVE", size: 2,
})
const repeated = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({
    SafeSyncStatus: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 2, migrationVerified: true }],
    SafeSyncEvents: [{
      events: [
        { vaultRevision: 1, resourceId: "repeat", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "repeat.md", contentHash: "r2", state: "LIVE" },
        { vaultRevision: 2, resourceId: "repeat", resourceRevision: 3, resourceType: "NOTE", action: "MODIFY", path: "repeat.md", contentHash: "r3", state: "LIVE" },
      ],
      latestVaultRevision: 2,
      nextRevision: 2,
      hasMore: false,
    }],
  }),
  createStateStore: () => repeatedStore,
  getLocalManifest: async () => [],
  operationId: () => "op-repeat",
  now: () => 1_000,
})
assert.equal((await repeated.refreshStatus(true)).state, "active")
await assert.rejects(() => repeated.prepareRemoteEvents(), /multiple unapplied events.*re-bootstrap/)
assert.equal(repeated.status.state, "error", "an event chain without intermediate content must fail closed")

const pendingStore = new MemoryStore()
pendingStore.baselines.set("pending.md", {
  path: "pending.md", resourceId: "pending", resourceRevision: 1, contentHash: "p1", vaultRevision: 0, state: "LIVE", size: 2,
})
pendingStore.pending.set("local-pending", {
  operationId: "local-pending", deviceId: "device-a", path: "pending.md", resourceId: "pending",
  createdAt: 1, expiresAt: 50_000, status: "pending", payload: { action: "MODIFY" },
})
const pendingRemote = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({
    SafeSyncStatus: [{ capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 1, migrationVerified: true }],
    SafeSyncEvents: [{
      events: [{ vaultRevision: 1, resourceId: "pending", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "pending.md", contentHash: "p2", state: "LIVE" }],
      latestVaultRevision: 1,
      nextRevision: 1,
      hasMore: false,
    }],
  }),
  createStateStore: () => pendingStore,
  getLocalManifest: async () => [],
  operationId: () => "op-pending",
  now: () => 1_000,
})
assert.equal((await pendingRemote.refreshStatus(true)).state, "active")
await pendingRemote.prepareRemoteEvents()
await assert.rejects(
  () => pendingRemote.claimRemoteEvent("NOTE", "UPSERT", "pending.md", "", "p2"),
  /pending local mutation/,
)
assert.equal(pendingStore.latestVaultRevision, 0)

const disconnectStore = new MemoryStore()
disconnectStore.baselines.set("one.md", {
  path: "one.md", resourceId: "one", resourceRevision: 1, contentHash: "one-1", vaultRevision: 0, state: "LIVE", size: 5,
})
disconnectStore.baselines.set("two.md", {
  path: "two.md", resourceId: "two", resourceRevision: 1, contentHash: "two-1", vaultRevision: 0, state: "LIVE", size: 5,
})
const disconnecting = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: new ScriptedTransport({
    SafeSyncStatus: [
      { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 2, migrationVerified: true },
      { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 2, migrationVerified: true },
    ],
    SafeSyncEvents: [{
      events: [
        { vaultRevision: 1, resourceId: "one", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "one.md", contentHash: "one-2", state: "LIVE" },
        { vaultRevision: 2, resourceId: "two", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "two.md", contentHash: "two-2", state: "LIVE" },
      ],
      latestVaultRevision: 2,
      nextRevision: 2,
      hasMore: false,
    }, {
      events: [
        { vaultRevision: 1, resourceId: "one", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "one.md", contentHash: "one-2", state: "LIVE" },
        { vaultRevision: 2, resourceId: "two", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "two.md", contentHash: "two-2", state: "LIVE" },
      ],
      latestVaultRevision: 2,
      nextRevision: 2,
      hasMore: false,
    }],
  }),
  createStateStore: () => disconnectStore,
  getLocalManifest: async () => [],
  operationId: () => "op-disconnect",
  now: () => 1_000,
})
assert.equal((await disconnecting.refreshStatus(true)).state, "active")
await disconnecting.prepareRemoteEvents()
const waitingOnFirstRevision = disconnecting.claimRemoteEvent("NOTE", "UPSERT", "two.md", "", "two-2")
disconnecting.cancelRemoteEvents(new Error("connection closed"))
await assert.rejects(() => waitingOnFirstRevision, /connection closed/)
assert.equal(disconnectStore.latestVaultRevision, 0)
assert.equal((await disconnecting.refreshStatus(true)).state, "active")
assert.equal(await disconnecting.prepareRemoteEvents(), 2, "reconnect must reload events from the durable cursor")
disconnecting.cancelRemoteEvents(new Error("test complete"))

const pagedReconnectStore = new MemoryStore()
pagedReconnectStore.baselines.set("one.md", {
  path: "one.md", resourceId: "paged-one", resourceRevision: 1, contentHash: "one-1", vaultRevision: 0, state: "LIVE", size: 5,
})
pagedReconnectStore.baselines.set("two.md", {
  path: "two.md", resourceId: "paged-two", resourceRevision: 1, contentHash: "two-1", vaultRevision: 0, state: "LIVE", size: 5,
})
const pagedReconnectTransport = new ScriptedTransport({
  SafeSyncStatus: [
    { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 2, migrationVerified: true },
    { capability: true, state: "STRICT", uid: 3, vaultId: 9, latestVaultRevision: 2, migrationVerified: true },
  ],
  SafeSyncEvents: [{
    events: [{ vaultRevision: 1, resourceId: "paged-one", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "one.md", contentHash: "one-2", state: "LIVE" }],
    latestVaultRevision: 2,
    nextRevision: 1,
    hasMore: true,
  }, new Error("connection closed during second page"), {
    events: [{ vaultRevision: 1, resourceId: "paged-one", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "one.md", contentHash: "one-2", state: "LIVE" }],
    latestVaultRevision: 2,
    nextRevision: 1,
    hasMore: true,
  }, {
    events: [{ vaultRevision: 2, resourceId: "paged-two", resourceRevision: 2, resourceType: "NOTE", action: "MODIFY", path: "two.md", contentHash: "two-2", state: "LIVE" }],
    latestVaultRevision: 2,
    nextRevision: 2,
    hasMore: false,
  }],
})
const pagedReconnect = new SafeSyncEngine({
  vault: "vault-a",
  serverUrl: "https://sync.example.com",
  transport: pagedReconnectTransport,
  createStateStore: () => pagedReconnectStore,
  getLocalManifest: async () => [],
  operationId: () => "op-paged-reconnect",
  now: () => 1_000,
})
assert.equal((await pagedReconnect.refreshStatus(true)).state, "active")
await assert.rejects(() => pagedReconnect.prepareRemoteEvents(), /connection closed during second page/)
assert.equal(pagedReconnectStore.latestVaultRevision, 0, "an interrupted page must not advance the durable cursor")
assert.equal((await pagedReconnect.refreshStatus(true)).state, "active")
assert.equal(await pagedReconnect.prepareRemoteEvents(), 2)
assert.deepEqual(
  pagedReconnectTransport.calls.filter((call) => call.action === "SafeSyncEvents").map((call) => call.payload.afterRevision),
  [0, 1, 0, 1],
  "reconnect must restart pagination from the durable Vault Revision",
)
pagedReconnect.cancelRemoteEvents(new Error("test complete"))

console.log("safe sync engine tests passed")
