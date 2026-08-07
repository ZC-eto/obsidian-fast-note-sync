import assert from "node:assert/strict"
import path from "node:path"
import esbuild from "esbuild"

const root = path.resolve(import.meta.dirname, "..")
const build = await esbuild.build({
  entryPoints: [path.join(root, "src", "lib", "sync", "safe_sync_inbound.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2020",
  write: false,
  plugins: [{
    name: "safe-sync-inbound-stubs",
    setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-stub" }))
      builder.onResolve({ filter: /^\.\.\/utils\/helpers$/ }, () => ({ path: "helpers", namespace: "test-stub" }))
      builder.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => {
        if (args.path === "obsidian") {
          return { contents: `
            export const normalizePath = (value) => value;
            export class TFile { static [Symbol.hasInstance](value) { return value?.kind === "file"; } }
            export class TFolder { static [Symbol.hasInstance](value) { return value?.kind === "folder"; } }
          ` }
        }
        return { contents: `
          export const hashContentAsync = async (content) => "hash:" + content;
          export const hashFileAsync = async (_app, path) => "file:" + path;
          export const vaultDelete = async (vault, file) => vault.delete(file);
        ` }
      })
    },
  }],
})
const source = Buffer.from(build.outputFiles[0].contents).toString("base64")
const { receiveSafeDirectEvent, receiveSafeNoteModify } = await import(`data:text/javascript;base64,${source}`)

globalThis.window = { setTimeout(callback) { callback(); return 0 } }

function makePlugin(runtimeOverrides = {}) {
  const file = { kind: "file", path: "note.md", content: "old", stat: { size: 3, mtime: 1 } }
  let modifyCount = 0
  let committed = false
  let rejected = false
  const event = {
    vaultRevision: 1,
    resourceId: "note-resource",
    resourceRevision: 2,
    resourceType: "NOTE",
    action: "MODIFY",
    path: "note.md",
    contentHash: "hash:new",
    state: "LIVE",
  }
  const runtime = {
    claimRemoteEvent: async () => event,
    verifyRemoteEvent: (_event, currentHash) => {
      assert.equal(currentHash, "hash:old")
      return true
    },
    commitRemoteEvent: async () => { committed = true },
    rejectRemoteEvent: () => { rejected = true },
    ...runtimeOverrides,
  }
  const plugin = {
    safeSyncRuntime: runtime,
    app: {
      vault: {
        getFileByPath: (target) => target === file.path ? file : null,
        getFolderByPath: () => null,
        read: async (target) => target.content,
        modify: async (target, content) => {
          modifyCount++
          target.content = content
          target.stat = { size: content.length, mtime: 2 }
        },
        rename: async (target, newPath) => { target.path = newPath },
        create: async () => { throw new Error("unexpected create") },
      },
    },
    lockManager: { withLock: async (_path, callback) => callback() },
    addIgnoredFile() {},
    removeIgnoredFile() {},
    fileHashManager: { setFileHash() {}, removeFileHash() {} },
    lastSyncMtime: new Map(),
    lastSyncPathRenamed: new Set(),
    pendingNoteModifies: new Map(),
    pendingNoteDeleteAcks: new Map(),
    localStorageManager: {
      getMetadata: () => 0,
      setMetadata() {},
      savePending() {},
    },
  }
  return {
    plugin,
    file,
    get modifyCount() { return modifyCount },
    get committed() { return committed },
    get rejected() { return rejected },
  }
}

const accepted = makePlugin()
await receiveSafeNoteModify({
  path: "note.md", content: "new", contentHash: "hash:new", ctime: 1, mtime: 2, lastTime: 3,
}, accepted.plugin)
assert.equal(accepted.file.content, "new")
assert.equal(accepted.modifyCount, 1)
assert.equal(accepted.committed, true)

const unmatched = makePlugin({
  claimRemoteEvent: async () => { throw new Error("no matching safe sync event") },
})
await assert.rejects(() => receiveSafeNoteModify({
  path: "note.md", content: "new", contentHash: "hash:new", ctime: 1, mtime: 2, lastTime: 3,
}, unmatched.plugin), /no matching safe sync event/)
assert.equal(unmatched.file.content, "old")
assert.equal(unmatched.modifyCount, 0)

const diverged = makePlugin({
  verifyRemoteEvent: () => { throw new Error("local content differs from the confirmed baseline") },
})
await assert.rejects(() => receiveSafeNoteModify({
  path: "note.md", content: "new", contentHash: "hash:new", ctime: 1, mtime: 2, lastTime: 3,
}, diverged.plugin), /differs from the confirmed baseline/)
assert.equal(diverged.file.content, "old")
assert.equal(diverged.modifyCount, 0)
assert.equal(diverged.rejected, true)

const renameEvent = {
  vaultRevision: 1,
  resourceId: "note-resource",
  resourceRevision: 2,
  resourceType: "NOTE",
  action: "RENAME",
  path: "moved.md",
  previousPath: "note.md",
  contentHash: "hash:old",
  state: "LIVE",
}
const directRename = makePlugin({
  claimRemoteEvent: async () => renameEvent,
  verifyRemoteEvent: (_event, sourceHash, targetHash) => {
    assert.equal(sourceHash, "hash:old")
    assert.equal(targetHash, null)
    return true
  },
})
await receiveSafeDirectEvent(renameEvent, directRename.plugin)
assert.equal(directRename.file.path, "moved.md")
assert.equal(directRename.committed, true, "rename events must apply without waiting for a legacy rename message")

console.log("safe sync inbound operator tests passed")
