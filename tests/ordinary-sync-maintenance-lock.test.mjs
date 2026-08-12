import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import ts from "typescript"

const root = path.resolve(import.meta.dirname, "..")
const sourcePath = path.join(root, "src", "lib", "sync", "operator.ts")
const source = fs.readFileSync(sourcePath, "utf8")
const handleSyncSource = source.match(/export const handleSync = async function[\s\S]*?plugin\.isSyncing = true;/)?.[0]
assert.ok(handleSyncSource, "handleSync prologue must be discoverable")

const executableSource = handleSyncSource
  .replace("export const handleSync", "const handleSync")
  .replace(/plugin\.isSyncing = true;[\s\S]*$/, "plugin.isSyncing = true; return 'started'; }")
const transpiled = ts.transpileModule(executableSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: sourcePath,
}).outputText

const messages = []
const context = { module: { exports: {} }, exports: {}, dump: (message) => messages.push(message) }
vm.runInNewContext(`${transpiled}\nmodule.exports = { handleSync };`, context, { filename: sourcePath })
const { handleSync } = context.module.exports

const locked = { safeMirrorManager: { isBusy: true }, isSyncing: false }
assert.equal(await handleSync(locked), undefined)
assert.equal(locked.isSyncing, false)
assert.match(messages.at(-1), /skipping ordinary sync/)

const unlocked = { safeMirrorManager: { isBusy: false }, isSyncing: false }
assert.equal(await handleSync(unlocked), "started")
assert.equal(unlocked.isSyncing, true)

console.log("ordinary sync maintenance lock tests passed")
