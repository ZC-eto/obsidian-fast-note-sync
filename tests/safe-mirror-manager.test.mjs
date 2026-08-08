import assert from "node:assert/strict"
import path from "node:path"
import esbuild from "esbuild"

const root = path.resolve(import.meta.dirname, "..")
const build = await esbuild.build({
  entryPoints: [path.join(root, "src", "lib", "sync", "safe_mirror_manager.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2020",
  write: false,
  plugins: [{
    name: "safe-mirror-manager-stubs",
    setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\.\/api\/http_api_service$/ }, () => ({ path: "http-api", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\.\/storage\/safe_mirror_recovery_store$/ }, () => ({ path: "recovery", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\.\/utils\/helpers$/ }, () => ({ path: "helpers", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\/operator_file$/ }, () => ({ path: "operator-file", namespace: "test-stub" }))
      builder.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => {
        if (args.path === "obsidian") {
          return { contents: `
            export const normalizePath = (value) => value.replace(/^\\/+|\\/+$/g, "");
            export class TFile { static [Symbol.hasInstance](value) { return value?.kind === "file"; } }
            export class TFolder { static [Symbol.hasInstance](value) { return value?.kind === "folder"; } }
          ` }
        }
        if (args.path === "http-api") {
          return { contents: `
            export class HttpApiService {
              async getNoteContent(path) { return globalThis.__safeMirrorHarness.remoteNote(path); }
              async getFileInfo(path) { return globalThis.__safeMirrorHarness.remoteFileInfo(path); }
              async downloadFileContent(path) { return globalThis.__safeMirrorHarness.remoteBinary(path); }
            }
          ` }
        }
        if (args.path === "recovery") {
          return { contents: `
            export class SafeMirrorRecoveryStore {
              constructor() { this.record = undefined; this.contents = new Map(); }
              async create(direction, changes) {
                this.record = { id: "record-1", direction, createdAt: Date.now(), updatedAt: Date.now(), status: "PREPARING", changes, entries: [] };
                this.contents.clear();
                return this.record;
              }
              async addEntry(record, entry, content) {
                const saved = { ...entry };
                if (content) { saved.contentFile = "memory:" + saved.path; this.contents.set(saved.contentFile, content.slice(0)); }
                record.entries.push(saved);
              }
              async update(record, status, error) { record.status = status; record.updatedAt = Date.now(); if (error) record.error = error; else delete record.error; }
              async latest() { return this.record; }
              async readContent(entry) { const content = this.contents.get(entry.contentFile); if (!content) throw new Error("missing recovery content"); return content.slice(0); }
            }
          ` }
        }
        if (args.path === "helpers") {
          return { contents: `
            export const generateUUID = () => "test-session";
            export const getSafeCtime = (stat) => stat.ctime || stat.mtime;
            export const hashContent = (value) => globalThis.__safeMirrorHarness.hashText(value);
            export const hashContentAsync = async (value) => globalThis.__safeMirrorHarness.hashText(value);
            export const hashArrayBuffer = async (value) => globalThis.__safeMirrorHarness.hashBinary(value);
            export const vaultDelete = async (vault, target) => vault.delete(target);
          ` }
        }
        return { contents: `
          export const BINARY_PREFIX_FILE_SYNC = 3;
          export const receiveFileUpload = async () => { throw new Error("unexpected attachment upload in this test"); };
        ` }
      })
    },
  }],
})
const source = Buffer.from(build.outputFiles[0].contents).toString("base64")
const { SafeMirrorManager } = await import(`data:text/javascript;base64,${source}`)

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytes(value) {
  return typeof value === "string" ? encoder.encode(value) : new Uint8Array(value)
}

function arrayBuffer(value) {
  const data = bytes(value)
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
}

function hashBytes(value) {
  return `h:${Buffer.from(bytes(value)).toString("hex")}`
}

function makeResource(resourceType, path, content = "") {
  const data = bytes(content)
  return {
    resourceType,
    path,
    content: data,
    contentHash: resourceType === "FOLDER" ? "" : hashBytes(data),
    size: resourceType === "FOLDER" ? 0 : data.byteLength,
    ctime: 10,
    mtime: 20,
    state: "LIVE",
  }
}

function cloneResource(resource) {
  return { ...resource, content: new Uint8Array(resource.content) }
}

function makeHarness({ local, remote, syncRole = "bidirectional", expiresAt = Date.now() + 60_000 }) {
  const localMap = new Map(local.map((item) => [item.path, cloneResource(item)]))
  const remoteMap = new Map(remote.map((item) => [item.path, cloneResource(item)]))
  const ignored = new Set()
  let saveCount = 0
  let commitCount = 0

  const manifest = (items) => [...items.values()].map(({ content: _content, ctime: _ctime, mtime: _mtime, ...item }) => ({ ...item }))
  const localFile = (resource) => resource && resource.resourceType !== "FOLDER" ? {
    kind: "file",
    path: resource.path,
    stat: { size: resource.size, ctime: resource.ctime, mtime: resource.mtime },
  } : null
  const localAbstract = (resource) => resource?.resourceType === "FOLDER" ? { kind: "folder", path: resource.path } : localFile(resource)
  const vault = {
    getAbstractFileByPath(target) { return localAbstract(localMap.get(target)) },
    getFileByPath(target) { return localFile(localMap.get(target)) },
    async read(file) { return decoder.decode(localMap.get(file.path).content) },
    async readBinary(file) { return arrayBuffer(localMap.get(file.path).content) },
    async createFolder(target) { localMap.set(target, makeResource("FOLDER", target)) },
    async createBinary(target, content, stat) {
      const resourceType = target.endsWith(".md") ? "NOTE" : "FILE"
      const item = makeResource(resourceType, target, content)
      item.ctime = stat.ctime
      item.mtime = stat.mtime
      localMap.set(target, item)
    },
    async modifyBinary(file, content, stat) {
      const current = localMap.get(file.path)
      const item = makeResource(current.resourceType, file.path, content)
      item.ctime = stat.ctime
      item.mtime = stat.mtime
      localMap.set(file.path, item)
    },
    async delete(target) {
      const prefix = `${target.path}/`
      for (const key of [...localMap.keys()]) if (key === target.path || key.startsWith(prefix)) localMap.delete(key)
    },
  }
  const engine = {
    async beginMirrorBootstrap() {
      return { sessionId: "bootstrap-1", expiresAt, snapshotVaultRevision: 1, manifestHash: "manifest", remoteItems: manifest(remoteMap) }
    },
    async localManifest() { return manifest(localMap) },
    async commitMirrorBootstrap() { commitCount++; runtime.status = { state: "active" } },
    async cancelMirrorBootstrap() {},
  }
  const applyMutation = (resourceType, input) => {
    if (input.action === "DELETE") {
      const prefix = `${input.path}/`
      for (const key of [...remoteMap.keys()]) if (key === input.path || key.startsWith(prefix)) remoteMap.delete(key)
      return
    }
    const existing = remoteMap.get(input.path)
    const content = resourceType === "NOTE" ? input.content : existing?.content || new Uint8Array()
    const next = makeResource(resourceType, input.path, content)
    if (input.contentHash) next.contentHash = input.contentHash
    if (input.size !== undefined) next.size = input.size
    next.ctime = input.ctime || existing?.ctime || 10
    next.mtime = input.mtime || existing?.mtime || 20
    remoteMap.set(input.path, next)
  }
  const runtime = {
    status: { state: "off" },
    engine,
    mutateNote: async (input) => applyMutation("NOTE", input),
    mutateFile: async (input) => applyMutation("FILE", input),
    mutateFolder: async (input) => applyMutation("FOLDER", input),
    baselineAt: (target) => remoteMap.has(target) ? { state: "LIVE", resourceType: remoteMap.get(target).resourceType } : undefined,
    hasLiveBaseline: (target) => remoteMap.has(target),
    startFileUpload: async () => { throw new Error("unexpected attachment upload in this test") },
    commitFileUpload: async () => undefined,
  }
  const plugin = {
    settings: { syncRole, safeRevisionSyncEnabled: false },
    websocket: { isConnected: () => true, SendBinary: async () => "sent" },
    safeSyncRuntime: runtime,
    app: { vault },
    saveSettings: async () => { saveCount++ },
    addIgnoredFile: (target) => ignored.add(target),
    removeIgnoredFile: (target) => ignored.delete(target),
    fileHashManager: { setFileHash() {}, removeFileHash() {} },
    folderSnapshotManager: { setFolderMtime() {}, removeFolder() {} },
  }
  const harness = {
    hashText: (value) => hashBytes(encoder.encode(value)),
    hashBinary: (value) => hashBytes(new Uint8Array(value)),
    remoteNote(target) {
      const item = remoteMap.get(target)
      if (!item || item.resourceType !== "NOTE") throw new Error(`remote note missing: ${target}`)
      return { content: decoder.decode(item.content), ctime: item.ctime, mtime: item.mtime }
    },
    remoteFileInfo(target) {
      const item = remoteMap.get(target)
      if (!item || item.resourceType !== "FILE") throw new Error(`remote file missing: ${target}`)
      return { size: item.size, mtime: item.mtime }
    },
    remoteBinary(target) {
      const item = remoteMap.get(target)
      if (!item || item.resourceType !== "FILE") throw new Error(`remote file missing: ${target}`)
      return arrayBuffer(item.content)
    },
  }
  globalThis.__safeMirrorHarness = harness
  return {
    plugin,
    localMap,
    remoteMap,
    get saveCount() { return saveCount },
    get commitCount() { return commitCount },
    assertNoIgnoredPaths() { assert.equal(ignored.size, 0) },
  }
}

function textAt(items, target) {
  const item = items.get(target)
  return item ? decoder.decode(item.content) : undefined
}

// REQ-MIRROR-001, REQ-BACKUP-001: local authority, verification, and remote rollback.
{
  const harness = makeHarness({
    local: [makeResource("NOTE", "shared.md", "local-new"), makeResource("NOTE", "local-only.md", "local-only")],
    remote: [makeResource("NOTE", "shared.md", "remote-old"), makeResource("NOTE", "remote-only.md", "remote-only")],
  })
  const manager = new SafeMirrorManager(harness.plugin)
  const session = await manager.prepare("LOCAL_TO_REMOTE")
  assert.equal(session.plan.updates.length, 1)
  assert.equal(session.plan.creates.length, 1)
  assert.equal(session.plan.deletes.length, 1)
  assert.equal(harness.remoteMap.has("local-only.md"), false, "preview must not mutate the remote target")

  const record = await manager.apply(session)
  assert.equal(record.status, "COMPLETED")
  assert.equal(textAt(harness.remoteMap, "shared.md"), "local-new")
  assert.equal(textAt(harness.remoteMap, "local-only.md"), "local-only")
  assert.equal(harness.remoteMap.has("remote-only.md"), false)
  assert.equal(harness.plugin.settings.safeRevisionSyncEnabled, true)
  assert.equal(harness.commitCount, 1)
  assert.equal(harness.saveCount, 1)

  const rolledBack = await manager.rollbackLatest()
  assert.equal(rolledBack.status, "ROLLED_BACK")
  assert.equal(textAt(harness.remoteMap, "shared.md"), "remote-old")
  assert.equal(textAt(harness.remoteMap, "remote-only.md"), "remote-only")
  assert.equal(harness.remoteMap.has("local-only.md"), false)
}

// REQ-MIRROR-002, REQ-BACKUP-001: remote authority, attachment restore, and local rollback.
{
  const harness = makeHarness({
    local: [makeResource("NOTE", "shared.md", "local-old"), makeResource("FILE", "asset.bin", Uint8Array.from([1, 2])), makeResource("NOTE", "local-only.md", "keep-me")],
    remote: [makeResource("NOTE", "shared.md", "remote-new"), makeResource("FILE", "asset.bin", Uint8Array.from([9, 8, 7])), makeResource("NOTE", "remote-only.md", "download-me")],
  })
  const manager = new SafeMirrorManager(harness.plugin)
  const session = await manager.prepare("REMOTE_TO_LOCAL")
  assert.equal(session.plan.updates.length, 2)
  assert.equal(session.plan.creates.length, 1)
  assert.equal(session.plan.deletes.length, 1)
  assert.equal(textAt(harness.localMap, "shared.md"), "local-old", "preview must not mutate the local target")

  const record = await manager.apply(session)
  assert.equal(record.status, "COMPLETED")
  assert.equal(textAt(harness.localMap, "shared.md"), "remote-new")
  assert.deepEqual([...harness.localMap.get("asset.bin").content], [9, 8, 7])
  assert.equal(textAt(harness.localMap, "remote-only.md"), "download-me")
  assert.equal(harness.localMap.has("local-only.md"), false)
  harness.assertNoIgnoredPaths()

  const rolledBack = await manager.rollbackLatest()
  assert.equal(rolledBack.status, "ROLLED_BACK")
  assert.equal(textAt(harness.localMap, "shared.md"), "local-old")
  assert.deepEqual([...harness.localMap.get("asset.bin").content], [1, 2])
  assert.equal(textAt(harness.localMap, "local-only.md"), "keep-me")
  assert.equal(harness.localMap.has("remote-only.md"), false)
  harness.assertNoIgnoredPaths()
}

// REQ-MIRROR-001: a local source change after preview invalidates the plan.
{
  const harness = makeHarness({ local: [makeResource("NOTE", "note.md", "before")], remote: [] })
  const manager = new SafeMirrorManager(harness.plugin)
  const session = await manager.prepare("LOCAL_TO_REMOTE")
  harness.localMap.set("note.md", makeResource("NOTE", "note.md", "after-preview"))
  await assert.rejects(() => manager.apply(session), /本地内容在预览后已变化/)
  assert.equal(harness.commitCount, 0)
}

// REQ-OBS-001: an expired preview cannot be applied.
{
  const harness = makeHarness({ local: [makeResource("NOTE", "note.md", "local")], remote: [], expiresAt: Date.now() - 1 })
  const manager = new SafeMirrorManager(harness.plugin)
  const session = await manager.prepare("LOCAL_TO_REMOTE")
  await assert.rejects(() => manager.apply(session), /镜像计划已过期/)
  assert.equal(harness.commitCount, 0)
}

// REQ-ROLE-001: a remote mirror device cannot authoritatively replace the server.
{
  const harness = makeHarness({ local: [makeResource("NOTE", "note.md", "local")], remote: [], syncRole: "remote-mirror" })
  const manager = new SafeMirrorManager(harness.plugin)
  const session = await manager.prepare("LOCAL_TO_REMOTE")
  await assert.rejects(() => manager.apply(session), /远端镜像端不能覆盖远端/)
  assert.equal(harness.commitCount, 0)
}

console.log("safe mirror manager integration tests passed")
