import assert from "node:assert/strict"
import path from "node:path"
import esbuild from "esbuild"

const root = path.resolve(import.meta.dirname, "..")
const build = await esbuild.build({
  entryPoints: [path.join(root, "src", "lib", "utils", "helpers.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2020",
  write: false,
  plugins: [{
    name: "file-hash-range-stubs",
    setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-stub" }))
      builder.onResolve({ filter: /^(\.\.\/\.\.\/i18n\/lang|\.\.\/\.\.\/main|\.\.\/sync\/sync_log_manager|\.\.\/helpers_obsidian_bypass)$/ }, (args) => ({ path: args.path, namespace: "test-stub" }))
      builder.onLoad({ filter: /.*/, namespace: "test-stub" }, (args) => {
        if (args.path === "obsidian") {
          return { contents: `
            export class Notice {}
            export const normalizePath = (value) => value
            export class TFolder {}
            export const Platform = { isMobile: false }
            export class App {}
          ` }
        }
        if (args.path.endsWith("i18n/lang")) return { contents: "export const $ = (value) => value;" }
        if (args.path.endsWith("main")) return { contents: "export default class FastSync {};" }
        if (args.path.endsWith("sync_log_manager")) return { contents: "export class SyncLogManager {};" }
        return { contents: `
          export const nativeFetch = async () => { throw new Error("not used") }
          export const vaultDelete = async () => undefined
          export const dump = () => undefined
          export const dumpError = () => undefined
          export const setLogEnabled = () => undefined
          export const logLevel = "off"
        ` }
      })
    },
  }],
})

const source = Buffer.from(build.outputFiles[0].contents).toString("base64")
const { configIsPathExcluded, normalizeRangeResponse } = await import(`data:text/javascript;base64,${source}`)

const full = Uint8Array.from({ length: 20 }, (_, index) => index).buffer
assert.deepEqual([...new Uint8Array(normalizeRangeResponse(full, 200, 5, 4))], [5, 6, 7, 8])
assert.deepEqual([...new Uint8Array(normalizeRangeResponse(full, 200, 0, 4))], [0, 1, 2, 3])

const partial = Uint8Array.from([9, 10, 11, 12]).buffer
assert.deepEqual([...new Uint8Array(normalizeRangeResponse(partial, 206, 5, 4))], [9, 10, 11, 12])
assert.deepEqual([...new Uint8Array(normalizeRangeResponse(partial, 200, 5, 4))], [9, 10, 11, 12])
assert.throws(() => normalizeRangeResponse(partial, 206, 5, 5), /too short/)
assert.throws(() => normalizeRangeResponse(partial, 200, 5, 5), /too short/)

const plugin = {
  manifest: { id: "fast-note-sync", dir: ".obsidian/plugins/fast-note-sync" },
  app: { vault: { configDir: ".obsidian" } },
  settings: { syncExcludeFolders: "", syncExcludeWhitelist: "" },
}
const privateStatePaths = [
  ".obsidian/plugins/fast-note-sync/fileHashMap.json",
  ".obsidian/plugins/fast-note-sync/fileHashMap-v2.json",
  ".obsidian/plugins/fast-note-sync/syncHashMap.json",
  ".obsidian/plugins/fast-note-sync/safe-sync/state-vault.json",
  ".obsidian/plugins/fast-note-sync/recovery/mirror/record/content/file.bin",
]
for (const privatePath of privateStatePaths) {
  assert.equal(configIsPathExcluded(privatePath, plugin), true, `${privatePath} must never enter config sync`)
}

console.log("file hash range response tests passed")
