import assert from "node:assert/strict"
import path from "node:path"
import esbuild from "esbuild"

const root = path.resolve(import.meta.dirname, "..")

async function loadModule(relativePath) {
  const build = await esbuild.build({
    entryPoints: [path.join(root, relativePath)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2020",
    write: false,
  })
  const source = Buffer.from(build.outputFiles[0].contents).toString("base64")
  return import(`data:text/javascript;base64,${source}`)
}

const { compareSafeMirrorDeletionOrder, createSafeMirrorPlan, safeMirrorPlanChangeCount } = await loadModule("src/lib/sync/safe_mirror_plan.ts")
const { safeSyncTextSize } = await loadModule("src/lib/sync/safe_sync_content.ts")
const {
  applySyncRoleSettingConflicts,
  isOfflineDeleteSyncManagedByRole,
  isReadonlySyncManagedByRole,
} = await loadModule("src/lib/sync/safe_sync_role.ts")

const local = [
  item("NOTE", "same.md", "same", 4),
  item("FILE", "new.bin", "new", 3),
  item("FOLDER", "replace", "", 0),
]
const remote = [
  item("NOTE", "same.md", "same", 4),
  item("NOTE", "remote-only.md", "old", 3),
  item("FILE", "replace", "file", 8),
  { ...item("NOTE", "deleted.md", "gone", 4), state: "DELETED" },
]
const plan = createSafeMirrorPlan("LOCAL_TO_REMOTE", local, remote)
assert.equal(plan.unchanged, 1)
assert.deepEqual(plan.creates.map((value) => value.path), ["new.bin"])
assert.deepEqual(plan.deletes.map((value) => value.path), ["remote-only.md"])
assert.deepEqual(plan.replacements.map((value) => value.path), ["replace"])
assert.equal(safeMirrorPlanChangeCount(plan), 3)
assert.equal(plan.highRiskDelete, true)

const localRootOnly = createSafeMirrorPlan("LOCAL_TO_REMOTE", [item("FOLDER", "/", "", 0)], [])
assert.equal(localRootOnly.sourceCount, 0)
assert.equal(safeMirrorPlanChangeCount(localRootOnly), 0, "the Vault root must not be created remotely")
const remoteRootOnly = createSafeMirrorPlan("LOCAL_TO_REMOTE", [], [item("FOLDER", "/", "", 0)])
assert.equal(remoteRootOnly.targetCount, 0)
assert.equal(safeMirrorPlanChangeCount(remoteRootOnly), 0, "the Vault root must not be deleted remotely")
assert.equal(safeSyncTextSize("a\nb"), 3)
assert.equal(safeSyncTextSize("a\r\nb"), 4)
assert.equal(safeSyncTextSize("中文"), 6)

const largeTarget = Array.from({ length: 500 }, (_, index) => item("NOTE", `n-${index}.md`, String(index), 1))
const fortyNineDeletes = createSafeMirrorPlan("LOCAL_TO_REMOTE", largeTarget.slice(49), largeTarget)
assert.equal(fortyNineDeletes.deletes.length, 49)
assert.equal(fortyNineDeletes.highRiskDelete, false)
const fiftyDeletes = createSafeMirrorPlan("LOCAL_TO_REMOTE", largeTarget.slice(50), largeTarget)
assert.equal(fiftyDeletes.deletes.length, 50)
assert.equal(fiftyDeletes.highRiskDelete, true)

const settings = { readonlySyncEnabled: false, offlineDeleteSyncEnabled: true }
assert.equal(applySyncRoleSettingConflicts(settings, "remote-mirror"), true)
assert.deepEqual(settings, { readonlySyncEnabled: true, offlineDeleteSyncEnabled: false })
assert.equal(applySyncRoleSettingConflicts(settings, "remote-mirror"), false)
assert.equal(applySyncRoleSettingConflicts(settings, "bidirectional"), true)
assert.deepEqual(settings, { readonlySyncEnabled: false, offlineDeleteSyncEnabled: false })
assert.equal(isReadonlySyncManagedByRole("bidirectional"), true)
assert.equal(isReadonlySyncManagedByRole("local-publisher"), true)
assert.equal(isReadonlySyncManagedByRole("remote-mirror"), true)
assert.equal(isOfflineDeleteSyncManagedByRole("bidirectional"), false)
assert.equal(isOfflineDeleteSyncManagedByRole("local-publisher"), false)
assert.equal(isOfflineDeleteSyncManagedByRole("remote-mirror"), true)

const rollbackDeletionOrder = [
  { path: "folder", resourceType: "FOLDER" },
  { path: "folder/child.md", resourceType: "NOTE" },
  { path: "other.bin", resourceType: "FILE" },
].sort(compareSafeMirrorDeletionOrder)
assert.deepEqual(rollbackDeletionOrder.map((item) => item.path), ["folder/child.md", "other.bin", "folder"])

console.log("safe mirror plan and device role tests passed")

function item(resourceType, pathValue, contentHash, size) {
  return { resourceType, path: pathValue, contentHash, size, state: "LIVE" }
}
