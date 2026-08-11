import assert from "node:assert/strict"
import path from "node:path"
import esbuild from "esbuild"

globalThis.window = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
  clearInterval: (timer) => globalThis.clearInterval(timer),
}

const root = path.resolve(import.meta.dirname, "..")
const build = await esbuild.build({
  entryPoints: [path.join(root, "src", "lib", "sync", "safe_sync_runtime.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2020",
  write: false,
  plugins: [{
    name: "safe-sync-runtime-stubs",
    setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\/safe_sync_engine$/ }, () => ({ path: "engine", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\/safe_sync_websocket_transport$/ }, () => ({ path: "transport", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\.\/storage\/safe_sync_state_store$/ }, () => ({ path: "state", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\.\/utils\/helpers$/ }, () => ({ path: "helpers", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\/safe_remote_delete_protector$/ }, () => ({ path: "delete-protector", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\/safe_sync_inbound$/ }, () => ({ path: "inbound", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\/safe_sync_role$/ }, () => ({ path: "role", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\/safe_sync_content$/ }, () => ({ path: "content", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\/operator_file$/ }, () => ({ path: "operator-file", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\.\/storage\/file_cloud_preview$/ }, () => ({ path: "cloud-preview", namespace: "test-stub" }))
      builder.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => {
        if (args.path === "obsidian") return { contents: `
          export const normalizePath = (value) => value;
          export class TFile { static [Symbol.hasInstance](value) { return value?.kind === "file"; } }
          export class TFolder { static [Symbol.hasInstance](value) { return value?.kind === "folder"; } }
        ` }
        if (args.path === "engine") return { contents: `
          export class SafeSyncEngine { constructor() { return globalThis.__safeRuntimeHarness.engine; } }
          export class SafeSyncManifestMismatchError extends Error { constructor() { super("mismatch"); this.mismatches = []; } }
        ` }
        if (args.path === "transport") return { contents: `
          export class SafeSyncTransportError extends Error {
            static [Symbol.hasInstance](value) { return value?.name === "SafeSyncTransportError"; }
          }
          export class SafeSyncWebSocketTransport { receive() { return false; } close() {} }
        ` }
        if (args.path === "state") return { contents: `
          export class SafeSyncStateStore {}
          export const createSafeSyncNamespace = () => "test";
        ` }
        if (args.path === "helpers") return { contents: `
          export const generateUUID = () => "operation";
          export const getPluginDir = () => ".obsidian/plugins/fast-note-sync";
          export const getSafeCtime = (stat) => stat.ctime || stat.mtime;
          export const hashContent = (value) => "path:" + value;
          export const hashContentAsync = async (value) => "text:" + value;
          export const hashFileAsync = async (_app, path) => globalThis.__safeRuntimeHarness.fileHashes.get(path);
          export const isFolderSyncPathExcluded = (path) => globalThis.__safeRuntimeHarness.excludedPaths.has(path);
          export const isPathExcluded = (path) => globalThis.__safeRuntimeHarness.excludedPaths.has(path);
          export const vaultDelete = async () => undefined;
        ` }
        if (args.path === "delete-protector") return { contents: `export class SafeRemoteDeleteProtector {}` }
        if (args.path === "inbound") return { contents: `export const receiveSafeDirectEvent = async () => undefined;` }
        if (args.path === "role") return { contents: `export const applySyncRoleSettingConflicts = () => false;` }
        if (args.path === "content") return { contents: `export const safeSyncTextSize = (value) => new TextEncoder().encode(value).byteLength;` }
        if (args.path === "cloud-preview") return { contents: `
          export class FileCloudPreview {
            static isRestrictedType(ext) { return [".mp3", ".pdf", ".png"].includes(ext); }
          }
        ` }
        return { contents: `
          export const receiveFileUpload = async (data) => {
            globalThis.__safeRuntimeHarness.uploads.push(data);
            await data.onUploadReady();
          };
        ` }
      })
    },
  }],
})
const source = Buffer.from(build.outputFiles[0].contents).toString("base64")
const { SafeSyncRuntime } = await import(`data:text/javascript;base64,${source}`)

function baseline(resourceType, itemPath, contentHash, size, resourceId = itemPath) {
  return { resourceType, path: itemPath, contentHash, size, resourceId, resourceRevision: 1, vaultRevision: 1, state: "LIVE" }
}

function makeHarness({ remoteEvents = [], readonlySyncEnabled = false, ignoredBaselines = [], pending = [], pendingRetryError, initialStatus } = {}) {
  const note = { kind: "file", path: "changed.md", stat: { size: 7, ctime: 10, mtime: 20 }, content: "changed" }
  const binary = { kind: "file", path: "new.bin", stat: { size: 3, ctime: 11, mtime: 21 } }
  const localFiles = new Map([[note.path, note], [binary.path, binary]])
  const localManifest = [
    { resourceType: "NOTE", path: note.path, contentHash: "text:changed", size: 7 },
    { resourceType: "FILE", path: binary.path, contentHash: "file:new", size: 3 },
  ]
  const baselines = [
    baseline("NOTE", "changed.md", "text:before", 6, "note-changed"),
    baseline("NOTE", "deleted.md", "text:deleted", 7, "note-deleted"),
    ...ignoredBaselines,
  ]
  const calls = []
  let prepareCount = 0
  let failed
  let startHandleCount = 0
  let statusRefreshCount = 0
  let pendingMutations = [...pending]
  const engine = {
    status: initialStatus || { state: "active", serverState: "STRICT", capability: true },
    store: { listBaselines: () => baselines, getBaseline: (target) => baselines.find((item) => item.path === target) },
    async refreshStatus() {
      statusRefreshCount++
      this.status = { state: "active", serverState: "STRICT", capability: true }
      return this.status
    },
    async prepareRemoteEvents() { prepareCount++; return remoteEvents.length },
    pendingRemoteEvents: () => remoteEvents,
    nextRemoteEvent: () => undefined,
    localManifest: async () => localManifest,
    retryablePending: () => [...pendingMutations],
    pullEvents: async () => remoteEvents,
    acknowledgePendingEvents: async () => 0,
    async retryPendingMutation(resourceType, item) {
      calls.push({ action: `RetrySafe${resourceType}Mutation`, input: item.payload })
      if (pendingRetryError) throw pendingRetryError
      pendingMutations = pendingMutations.filter((pending) => pending.operationId !== item.operationId)
    },
    async retryPendingFileUploadStart(item, chunkSize) {
      calls.push({ action: "RetrySafeFileUploadStart", input: item.payload, chunkSize })
      return { operationId: item.operationId, sessionId: "12345678-1234-1234-1234-123456789099", nextChunkIndex: 0, expiresAt: 1000 }
    },
    async mutate(resourceType, input) { calls.push({ action: `Safe${resourceType}Mutation`, input }) },
    async startFileUpload(input, chunkSize) {
      calls.push({ action: "SafeFileUploadStart", input, chunkSize })
      return { operationId: "file-operation", sessionId: "12345678-1234-1234-1234-123456789012", nextChunkIndex: 0, expiresAt: 1000 }
    },
    async commitFileUpload(operationId, sessionId, contentHash, size) {
      calls.push({ action: "SafeFileUploadCommit", operationId, sessionId, contentHash, size })
      const recovered = pendingMutations.find((pending) => pending.operationId === operationId)
      if (recovered) {
        pendingMutations = pendingMutations.filter((pending) => pending.operationId !== operationId)
        baselines.push(baseline("FILE", recovered.path, contentHash, size, recovered.path))
      }
    },
    async beginMirrorBootstrap() {
      calls.push({ action: "SafeSyncBootstrapStart" })
      return {
        sessionId: "mirror-session", expiresAt: 10_000, snapshotVaultRevision: 2, manifestHash: "mirror-hash",
        remoteItems: localManifest.map((item) => ({
          ...item, resourceId: item.path, resourceRevision: 2, state: "LIVE",
        })),
      }
    },
    mirrorSnapshotMismatches: () => [],
    async commitMirrorBootstrap(snapshot) {
      calls.push({ action: "SafeSyncBootstrapCommit" })
      for (const item of snapshot.remoteItems) {
        const existing = baselines.find((baseline) => baseline.path === item.path)
        if (existing) Object.assign(existing, item)
        else baselines.push({ ...item, vaultRevision: snapshot.snapshotVaultRevision })
      }
    },
    async cancelMirrorBootstrap() { calls.push({ action: "SafeSyncBootstrapCancel" }) },
    async discardPendingForPaths(paths) {
      const targets = new Set(paths)
      const before = pendingMutations.length
      pendingMutations = pendingMutations.filter((pending) => !targets.has(pending.path))
      return before - pendingMutations.length
    },
    failClosed(error) { failed = error },
    cancelRemoteEvents() {},
  }
  const cacheCalls = []
  let refreshCount = 0
  const plugin = {
    settings: {
      safeRevisionSyncEnabled: true,
      readonlySyncEnabled,
      vault: "vault",
      syncRole: "bidirectional",
      cloudPreviewEnabled: ignoredBaselines.some((item) => item.path === "cloud.mp3"),
      cloudPreviewTypeRestricted: true,
    },
    runApi: "https://sync.example.com",
    websocket: { isConnected: () => true, StartHandle: async () => { startHandleCount++ } },
    isSyncing: false,
    isSyncRequesting: false,
    app: { vault: {
      getFileByPath: (target) => localFiles.get(target) || null,
      getAbstractFileByPath: (target) => localFiles.get(target) || null,
      read: async (file) => file.content,
    } },
    fileHashManager: {
      removeFileHash: (target) => cacheCalls.push(["remove-file", target]),
      removeFileHashes: (targets) => cacheCalls.push(["remove-files", [...targets]]),
      setFileHash: (target, hash) => cacheCalls.push(["set-file", target, hash]),
    },
    folderSnapshotManager: {
      removeFolder: (target) => cacheCalls.push(["remove-folder", target]),
      removeFolders: (targets) => cacheCalls.push(["remove-folders", [...targets]]),
      setFolderMtime: (target) => cacheCalls.push(["set-folder", target]),
    },
    lastSyncMtime: new Map(),
    settingTab: { refresh: () => { refreshCount++ } },
  }
  const harness = {
    engine,
    fileHashes: new Map([["new.bin", "file:new"]]),
    uploads: [],
    excludedPaths: new Set(ignoredBaselines.filter((item) => item.path === "excluded.md").map((item) => item.path)),
  }
  globalThis.__safeRuntimeHarness = harness
  return {
    runtime: new SafeSyncRuntime(plugin),
    plugin,
    calls,
    cacheCalls,
    harness,
    get prepareCount() { return prepareCount },
    get failed() { return failed },
    get refreshCount() { return refreshCount },
    get startHandleCount() { return startHandleCount },
    get statusRefreshCount() { return statusRefreshCount },
  }
}

{
  const test = makeHarness()
  assert.equal(await test.runtime.prepareStartupSync(), 3)
  assert.equal(test.prepareCount, 2, "successful local mutations must refresh the remote revision queue")
  assert.deepEqual(test.calls.map((call) => call.action), [
    "SafeNOTEMutation",
    "SafeFileUploadStart",
    "SafeFileUploadCommit",
    "SafeNOTEMutation",
  ])
  assert.equal(test.calls[0].input.action, "DELETE")
  assert.equal(test.calls[3].input.action, "MODIFY")
  assert.equal(test.harness.uploads.length, 1)
  assert.equal(test.harness.uploads[0].awaitCompletion, true)
  assert.equal(typeof test.harness.uploads[0].onUploadReady, "function")
  assert.equal(test.failed, undefined)
}

{
  const test = makeHarness({
    initialStatus: { state: "error", serverState: "STRICT", capability: true, message: "stale legacy push" },
  })
  assert.equal(await test.runtime.prepareStartupSync(), 3)
  assert.equal(test.statusRefreshCount, 1, "startup reconciliation must recover a stale client error from server status")
  assert.equal(test.harness.engine.status.state, "active")
  assert.equal(test.failed, undefined)
}

{
  const remoteEvent = {
    vaultRevision: 2,
    resourceId: "note-changed",
    resourceRevision: 2,
    resourceType: "NOTE",
    action: "MODIFY",
    path: "changed.md",
    contentHash: "text:remote",
    state: "LIVE",
  }
  const test = makeHarness({ remoteEvents: [remoteEvent] })
  await assert.rejects(() => test.runtime.prepareStartupSync(), /concurrent local and remote changes/)
  assert.equal(test.calls.length, 0)
  assert.ok(test.failed instanceof Error)
  assert.equal(test.refreshCount, 1)
}

{
  const test = makeHarness({ readonlySyncEnabled: true })
  assert.equal(await test.runtime.prepareStartupSync(), 0)
  assert.equal(test.prepareCount, 1)
  assert.equal(test.calls.length, 0)
}

{
  const test = makeHarness({
    pending: [{
      operationId: "pending-file", deviceId: "device-a", resourceType: "FILE", path: "new.bin",
      createdAt: 1, expiresAt: 10_000, status: "pending",
      payload: { action: "CREATE", path: "new.bin", contentHash: "file:new", size: 3, ctime: 11, mtime: 21 },
    }],
  })
  assert.equal(await test.runtime.prepareStartupSync(), 3, "one recovered upload and two remaining local changes must complete")
  assert.deepEqual(test.calls.slice(0, 2).map((call) => call.action), ["RetrySafeFileUploadStart", "SafeFileUploadCommit"])
  assert.equal(test.harness.uploads[0].expectedContentHash, "file:new")
}

{
  const conflict = Object.assign(new Error("path is live"), {
    name: "SafeSyncTransportError",
    errorCode: "PATH_STATE_CONFLICT",
  })
  const test = makeHarness({
    pendingRetryError: conflict,
    pending: [{
      operationId: "stale-create", deviceId: "device-a", resourceType: "NOTE", path: "changed.md",
      createdAt: 1, expiresAt: 10_000, status: "pending",
      payload: { action: "CREATE", path: "changed.md", contentHash: "text:old", size: 3, content: "old" },
    }],
  })
  assert.equal(await test.runtime.prepareStartupSync(), 2)
  assert.deepEqual(test.calls.slice(0, 4).map((call) => call.action), [
    "RetrySafeNOTEMutation",
    "SafeSyncBootstrapStart",
    "SafeSyncBootstrapCommit",
    "SafeNOTEMutation",
  ])
  assert.equal(test.calls[3].input.action, "MODIFY", "a matching live target must receive a forced safe update")
}

{
  const test = makeHarness({
    ignoredBaselines: [
      baseline("FILE", "cloud.mp3", "cloud", 10, "cloud-file"),
      baseline("NOTE", "excluded.md", "excluded", 8, "excluded-note"),
    ],
  })
  assert.equal(await test.runtime.prepareStartupSync(), 3)
  assert.equal(test.calls.some((call) => call.input?.path === "cloud.mp3" || call.input?.path === "excluded.md"), false)
}

{
  const test = makeHarness()
  test.plugin.isSyncing = true
  test.runtime.queueRemoteRefresh()
  test.runtime.queueRemoteRefresh()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(test.startHandleCount, 0, "remote refresh must wait for the active sync")
  test.plugin.isSyncing = false
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(test.startHandleCount, 1, "coalesced safe events must trigger exactly one follow-up sync")
}

const guardBuild = await esbuild.build({
  entryPoints: [path.join(root, "src", "lib", "sync", "safe_sync_protocol_guard.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
})
const guardSource = Buffer.from(guardBuild.outputFiles[0].contents).toString("base64")
const { shouldIgnoreLegacyPush } = await import(`data:text/javascript;base64,${guardSource}`)
assert.equal(shouldIgnoreLegacyPush("safe"), true)
assert.equal(shouldIgnoreLegacyPush("paused"), true)
assert.equal(shouldIgnoreLegacyPush("safe", true), false)
assert.equal(shouldIgnoreLegacyPush("legacy"), false)

console.log("safe sync startup runtime tests passed")
