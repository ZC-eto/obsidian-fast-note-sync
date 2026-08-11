import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import ts from "typescript"

const root = path.resolve(import.meta.dirname, "..")

function loadTypeScript(relPath, requireStub = () => { throw new Error("unexpected import") }) {
  const sourcePath = path.join(root, relPath)
  const source = fs.readFileSync(sourcePath, "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, { require: requireStub, module, exports: module.exports, console, Date, Math, JSON, Error })
  return module.exports
}

const stateModule = loadTypeScript("src/lib/storage/safe_sync_state_store.ts")
const deleteModule = loadTypeScript("src/lib/sync/safe_remote_delete_protector.ts", (id) => {
  if (id === "../storage/safe_sync_state_store") return stateModule
  throw new Error(`unexpected import: ${id}`)
})

const {
  SAFE_SYNC_OPERATION_RETENTION_MS,
  SafeSyncStateCorruptError,
  SafeSyncStateStore,
  createSafeSyncNamespace,
  createSafeSyncServerFingerprint,
} = stateModule
const { SafeRemoteDeleteProtector } = deleteModule

class MemoryAdapter {
  files = new Map()
  directories = new Set()
  failRecoveryWrite = false

  async exists(target) { return this.files.has(target) || this.directories.has(target) }
  async read(target) {
    const value = this.files.get(target)
    if (typeof value !== "string") throw new Error(`not a text file: ${target}`)
    return value
  }
  async write(target, value) { this.files.set(target, value) }
  async readBinary(target) {
    const value = this.files.get(target)
    if (!(value instanceof ArrayBuffer)) throw new Error(`not a binary file: ${target}`)
    return value.slice(0)
  }
  async writeBinary(target, value) {
    if (this.failRecoveryWrite && target.includes("/recovery/")) throw new Error("recovery is read-only")
    this.files.set(target, value.slice(0))
  }
  async rename(from, to) {
    if (!this.files.has(from)) throw new Error(`missing source: ${from}`)
    this.files.set(to, this.files.get(from))
    this.files.delete(from)
  }
  async remove(target) { this.files.delete(target) }
  async mkdir(target) { this.directories.add(target) }
}

function makeHost(localStorage, adapter) {
  return {
    manifest: { id: "fast-note-sync", dir: ".obsidian/plugins/fast-note-sync" },
    app: {
      loadLocalStorage: (key) => localStorage.get(key) ?? null,
      saveLocalStorage: (key, value) => localStorage.set(key, value),
      vault: { configDir: ".obsidian", adapter },
    },
  }
}

const fingerprint = createSafeSyncServerFingerprint("HTTPS://SYNC.EXAMPLE.COM/")
assert.equal(fingerprint, createSafeSyncServerFingerprint("https://sync.example.com"))
const namespace = createSafeSyncNamespace(fingerprint, 1, 2)
assert.notEqual(namespace, createSafeSyncNamespace(fingerprint, 1, 3), "vault id must isolate state")

const localStorage = new Map()
const adapter = new MemoryAdapter()
const host = makeHost(localStorage, adapter)
const store = new SafeSyncStateStore(host, namespace, "device-a")
await store.initialize()
await store.replaceBootstrapBaselines([{
  path: "notes/a.md", resourceId: "resource-a", resourceRevision: 1,
  contentHash: "hash-a", vaultRevision: 0, state: "LIVE", size: 10,
}], 0)
assert.equal(store.bootstrapComplete, true)
const createdAt = 1_000
await store.putPending({
  operationId: "op-a", deviceId: "device-a", path: "notes/a.md", resourceId: "resource-a",
  createdAt, expiresAt: createdAt + SAFE_SYNC_OPERATION_RETENTION_MS, status: "pending", payload: { action: "MODIFY" },
})

const statePath = `.obsidian/plugins/fast-note-sync/safe-sync/state-${namespace}.json`
assert.equal(localStorage.size, 1, "state must be mirrored to localStorage")
assert.equal(adapter.files.has(statePath), true, "state must be atomically mirrored to the plugin directory")

localStorage.clear()
const restored = new SafeSyncStateStore(host, namespace, "new-device-id-must-not-replace-persisted-id")
await restored.initialize()
assert.equal(restored.deviceId, "device-a")
assert.equal(restored.bootstrapComplete, true)
assert.equal(restored.getPending("op-a").operationId, "op-a")
assert.equal(localStorage.size, 1, "file recovery must heal localStorage")

const emptyNamespace = createSafeSyncNamespace(fingerprint, 1, 4)
const emptyLocalStorage = new Map()
const emptyAdapter = new MemoryAdapter()
const emptyHost = makeHost(emptyLocalStorage, emptyAdapter)
const emptyStore = new SafeSyncStateStore(emptyHost, emptyNamespace, "device-empty")
await emptyStore.initialize()
assert.equal(emptyStore.bootstrapComplete, false)
await emptyStore.replaceBootstrapBaselines([], 0)
assert.equal(emptyStore.bootstrapComplete, true)
emptyLocalStorage.clear()
const restoredEmptyStore = new SafeSyncStateStore(emptyHost, emptyNamespace, "replacement-device")
await restoredEmptyStore.initialize()
assert.equal(restoredEmptyStore.bootstrapComplete, true, "empty Vault bootstrap completion must survive reconnect")

await assert.rejects(() => restored.acknowledge({
  operationId: "op-a", path: "other.md", resourceId: "resource-a", resourceRevision: 2,
  contentHash: "hash-b", vaultRevision: 1,
}), /does not match/)
assert.equal(restored.getPending("op-a").status, "pending", "mismatched ACK must not advance state")

await restored.acknowledge({
  operationId: "op-a", path: "notes/a.md", resourceId: "resource-a", resourceRevision: 2,
  contentHash: "hash-b", vaultRevision: 1, size: 11,
})
assert.equal(restored.getPending("op-a"), undefined)
assert.equal(restored.getBaseline("notes/a.md").resourceRevision, 2)
assert.equal(restored.latestVaultRevision, 1)

await restored.putPending({
  operationId: "op-folder", deviceId: "device-a", resourceType: "FOLDER", path: "notes/tree",
  createdAt: 1_250, expiresAt: 1_250 + SAFE_SYNC_OPERATION_RETENTION_MS, status: "pending", payload: { action: "DELETE" },
})
assert.equal(restored.getPending("op-folder").resourceType, "FOLDER")
assert.equal(restored.hasPendingForPath("notes/tree/child.md"), true, "a folder operation must block overlapping child writes")
await restored.removePending("op-folder")

await restored.putPending({
  operationId: "op-gap-ack", deviceId: "device-a", path: "notes/a.md", resourceId: "resource-a",
  createdAt: 1_500, expiresAt: 1_500 + SAFE_SYNC_OPERATION_RETENTION_MS, status: "pending", payload: { action: "MODIFY" },
})
await restored.acknowledge({
  operationId: "op-gap-ack", path: "notes/a.md", resourceId: "resource-a", resourceRevision: 3,
  contentHash: "hash-c", vaultRevision: 4, size: 12,
})
assert.equal(restored.latestVaultRevision, 1, "an ACK must not skip unapplied Vault events")

await restored.putPending({
  operationId: "op-expired", deviceId: "device-a", path: "notes/expired.md",
  createdAt: 2_000, expiresAt: 3_000, status: "pending", payload: { action: "CREATE" },
})
const expired = await restored.expirePending(3_001)
assert.equal(expired.length, 1)
assert.equal(restored.listRetryablePending(3_001).length, 0, "expired pending must never be retried")

const corruptLocal = new Map([[`fns-safe-sync-${namespace}`, "{bad-json"]])
const corruptAdapter = new MemoryAdapter()
corruptAdapter.files.set(statePath, "{also-bad")
const corruptStore = new SafeSyncStateStore(makeHost(corruptLocal, corruptAdapter), namespace, "device-a")
await assert.rejects(() => corruptStore.initialize(), (error) => error instanceof SafeSyncStateCorruptError)

await restored.replaceBootstrapBaselines([{
  path: "notes/delete.md", resourceId: "resource-delete", resourceRevision: 4,
  contentHash: "delete-hash", vaultRevision: 8, state: "LIVE", size: 3,
}], 8)
const deleteBytes = new Uint8Array([1, 2, 3]).buffer
adapter.files.set("notes/delete.md", deleteBytes)
const protector = new SafeRemoteDeleteProtector(
  adapter, restored, ".obsidian/plugins/fast-note-sync/recovery/safe-sync", () => 9_999,
)

const unknown = await protector.apply({
  path: "notes/unknown.md", resourceId: "unknown", resourceRevision: 1,
  vaultRevision: 9, contentHash: "unknown-hash",
}, "unknown-hash")
assert.equal(unknown.reason, "unknown-baseline")

const mismatch = await protector.apply({
  path: "notes/delete.md", resourceId: "resource-delete", resourceRevision: 5,
  vaultRevision: 9, contentHash: "tombstone-hash",
}, "local-changed-hash")
assert.equal(mismatch.outcome, "conflict")
assert.equal(adapter.files.has("notes/delete.md"), true, "hash mismatch must preserve the local file")

adapter.failRecoveryWrite = true
const recoveryFailure = await protector.apply({
  path: "notes/delete.md", resourceId: "resource-delete", resourceRevision: 5,
  vaultRevision: 9, contentHash: "tombstone-hash",
}, "delete-hash")
assert.equal(recoveryFailure.reason, "recovery-failed")
assert.equal(adapter.files.has("notes/delete.md"), true, "recovery failure must block deletion")

adapter.files.delete("notes/delete.md")
const alreadyMissing = await protector.apply({
  path: "notes/delete.md", resourceId: "resource-delete", resourceRevision: 5,
  vaultRevision: 9, contentHash: "tombstone-hash",
}, "hash-is-unavailable-for-a-missing-file")
assert.equal(alreadyMissing.outcome, "ignored", "an already missing path is an idempotent delete after revision checks pass")
await restored.replaceBootstrapBaselines([{
  path: "notes/delete.md", resourceId: "resource-delete", resourceRevision: 4,
  contentHash: "delete-hash", vaultRevision: 8, state: "LIVE", size: 3,
}], 8)
adapter.files.set("notes/delete.md", deleteBytes)

adapter.failRecoveryWrite = false
const deleted = await protector.apply({
  path: "notes/delete.md", resourceId: "resource-delete", resourceRevision: 5,
  vaultRevision: 9, contentHash: "tombstone-hash",
}, "delete-hash")
assert.equal(deleted.outcome, "deleted")
assert.equal(adapter.files.has("notes/delete.md"), false)
assert.equal(adapter.files.has(deleted.recoveryPath), true, "recovery image must exist before local deletion")
assert.equal(restored.getBaseline("notes/delete.md").state, "DELETED")
assert.equal(restored.getBaseline("notes/delete.md").resourceRevision, 5)

console.log("safe-sync-state.test.mjs: all scenarios passed")
