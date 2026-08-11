import assert from "node:assert/strict"
import path from "node:path"
import esbuild from "esbuild"

const root = path.resolve(import.meta.dirname, "..")
const build = await esbuild.build({
  entryPoints: [path.join(root, "src", "lib", "sync", "safe_sync_reconciler.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2020",
  write: false,
})
const source = Buffer.from(build.outputFiles[0].contents).toString("base64")
const { planSafeLocalChanges, SafeSyncLocalConflictError } = await import(`data:text/javascript;base64,${source}`)

function local(resourceType, itemPath, contentHash = "", size = 0) {
  return { resourceType, path: itemPath, contentHash, size }
}

function baseline(resourceType, itemPath, contentHash = "", size = 0, resourceId = itemPath) {
  return { resourceType, path: itemPath, contentHash, size, resourceId, resourceRevision: 1, vaultRevision: 1, state: "LIVE" }
}

{
  const changes = planSafeLocalChanges([
    local("FOLDER", "docs"),
    local("NOTE", "docs/changed.md", "new", 3),
    local("FILE", "new.bin", "file-new", 8),
  ], [
    baseline("FOLDER", "docs"),
    baseline("NOTE", "docs/changed.md", "old", 3),
    baseline("FILE", "removed.bin", "removed", 4),
  ], [])
  assert.deepEqual(changes.map((item) => `${item.action}:${item.path}`), [
    "DELETE:removed.bin",
    "CREATE:new.bin",
    "MODIFY:docs/changed.md",
  ])
}

{
  const changes = planSafeLocalChanges([
    local("NOTE", "renamed.md", "same", 4),
  ], [
    baseline("NOTE", "old.md", "same", 4, "note-1"),
  ], [])
  assert.deepEqual(changes, [{
    action: "RENAME",
    resourceType: "NOTE",
    path: "renamed.md",
    previousPath: "old.md",
    contentHash: "same",
    size: 4,
  }])
}

{
  const changes = planSafeLocalChanges([
    local("FOLDER", "new"),
    local("NOTE", "new/a.md", "a", 1),
    local("FILE", "new/b.bin", "b", 1),
  ], [
    baseline("FOLDER", "old", "", 0, "folder-1"),
    baseline("NOTE", "old/a.md", "a", 1, "note-1"),
    baseline("FILE", "old/b.bin", "b", 1, "file-1"),
  ], [])
  assert.deepEqual(changes, [{
    action: "RENAME",
    resourceType: "FOLDER",
    path: "new",
    previousPath: "old",
    contentHash: "",
    size: 0,
  }])
}

{
  const remoteEvent = {
    vaultRevision: 2,
    resourceId: "note-1",
    resourceRevision: 2,
    resourceType: "NOTE",
    action: "MODIFY",
    path: "shared.md",
    contentHash: "remote",
    state: "LIVE",
  }
  assert.throws(() => planSafeLocalChanges(
    [local("NOTE", "shared.md", "local", 5)],
    [baseline("NOTE", "shared.md", "base", 4, "note-1")],
    [remoteEvent],
  ), (error) => error instanceof SafeSyncLocalConflictError && error.paths[0] === "shared.md")
}

{
  const remoteFolderDelete = {
    vaultRevision: 2,
    resourceId: "folder-1",
    resourceRevision: 2,
    resourceType: "FOLDER",
    action: "DELETE",
    path: "tree",
    contentHash: "",
    state: "DELETED",
  }
  assert.throws(() => planSafeLocalChanges(
    [local("FOLDER", "tree"), local("NOTE", "tree/a.md", "local", 5)],
    [baseline("FOLDER", "tree", "", 0, "folder-1"), baseline("NOTE", "tree/a.md", "base", 4, "note-1")],
    [remoteFolderDelete],
  ), /concurrent local and remote changes/)
}

{
  const changes = planSafeLocalChanges([
    local("NOTE", "new-a.md", "same", 4),
    local("NOTE", "new-b.md", "same", 4),
  ], [
    baseline("NOTE", "old-a.md", "same", 4, "old-a"),
    baseline("NOTE", "old-b.md", "same", 4, "old-b"),
  ], [])
  assert.equal(changes.filter((item) => item.action === "RENAME").length, 0, "ambiguous content matches must not guess a rename")
  assert.equal(changes.filter((item) => item.action === "DELETE").length, 2)
  assert.equal(changes.filter((item) => item.action === "CREATE").length, 2)
}

{
  const changes = planSafeLocalChanges(
    [local("FILE", "same-path", "binary", 6)],
    [baseline("NOTE", "same-path", "note", 4, "note-1")],
    [],
  )
  assert.deepEqual(changes.map((item) => `${item.action}:${item.resourceType}`), ["DELETE:NOTE", "CREATE:FILE"])
}

console.log("safe sync startup reconciler tests passed")
