import assert from "node:assert/strict"
import path from "node:path"
import esbuild from "esbuild"

const root = path.resolve(import.meta.dirname, "..")
const build = await esbuild.build({
  entryPoints: [path.join(root, "src", "lib", "storage", "safe_mirror_recovery_store.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2020",
  write: false,
  plugins: [{
    name: "safe-mirror-recovery-stubs",
    setup(builder) {
      builder.onResolve({ filter: /^\.\.\/utils\/helpers$/ }, () => ({ path: "helpers", namespace: "test-stub" }))
      builder.onLoad({ filter: /.*/, namespace: "test-stub" }, () => ({
        contents: `
          let sequence = 0;
          export const generateUUID = () => "uuid-" + (++sequence);
          export const getPluginDir = () => ".obsidian/plugins/fast-note-sync";
        `,
      }))
    },
  }],
})
const source = Buffer.from(build.outputFiles[0].contents).toString("base64")
const { SafeMirrorRecoveryStore } = await import(`data:text/javascript;base64,${source}`)

function createAdapter() {
  const files = new Map()
  const folders = new Set()
  const normalize = (value) => value.replace(/^\/+|\/+$/g, "")
  return {
    files,
    async exists(target) { return files.has(normalize(target)) || folders.has(normalize(target)) },
    async mkdir(target) { folders.add(normalize(target)) },
    async write(target, content) { files.set(normalize(target), content) },
    async read(target) {
      const content = files.get(normalize(target))
      if (content === undefined) throw new Error(`missing file: ${target}`)
      return content
    },
    async writeBinary(target, content) { files.set(normalize(target), content.slice(0)) },
    async readBinary(target) {
      const content = files.get(normalize(target))
      if (!content) throw new Error(`missing binary: ${target}`)
      return content.slice(0)
    },
    async list(target) {
      const prefix = `${normalize(target)}/`
      const directFolders = [...folders].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"))
      const directFiles = [...files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"))
      return { folders: directFolders, files: directFiles }
    },
    async rmdir(target) {
      const normalized = normalize(target)
      for (const item of [...files.keys()]) if (item === normalized || item.startsWith(`${normalized}/`)) files.delete(item)
      for (const item of [...folders]) if (item === normalized || item.startsWith(`${normalized}/`)) folders.delete(item)
    },
  }
}

const adapter = createAdapter()
const store = new SafeMirrorRecoveryStore({ app: { vault: { adapter } } })

const completed = await store.create("LOCAL_TO_REMOTE", 1)
await store.update(completed, "COMPLETED")

const aborted = await store.create("LOCAL_TO_REMOTE", 1)
await store.update(aborted, "ABORTED", "preview changed")
assert.equal((await store.latest()).id, completed.id, "an aborted attempt must not hide the latest applied overwrite")

const latestPath = ".obsidian/plugins/fast-note-sync/recovery/mirror/latest.json"
await adapter.write(latestPath, JSON.stringify({ id: aborted.id }))
assert.equal((await store.latest()).id, completed.id, "legacy aborted pointers must be repaired")
assert.equal(JSON.parse(await adapter.read(latestPath)).id, completed.id)

await adapter.write(latestPath, JSON.stringify({}))
assert.equal((await store.latest()).id, completed.id, "an empty pointer must fall back to retained records")

const applying = await store.create("REMOTE_TO_LOCAL", 2)
await store.update(applying, "APPLYING")
assert.equal((await store.latest()).id, applying.id)
await store.update(applying, "ROLLED_BACK")
assert.equal((await store.latest()).status, "ROLLED_BACK", "a rollback must block older recovery points")

console.log("safe mirror recovery store tests passed")
