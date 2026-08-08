import assert from "node:assert/strict"
import path from "node:path"
import esbuild from "esbuild"

const root = path.resolve(import.meta.dirname, "..")
const build = await esbuild.build({
  entryPoints: [path.join(root, "src", "lib", "sync", "safe_sync_websocket_transport.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2020",
  write: false,
})
const source = Buffer.from(build.outputFiles[0].contents).toString("base64")
globalThis.window = globalThis
const { SafeSyncTransportError, SafeSyncWebSocketTransport } = await import(`data:text/javascript;base64,${source}`)

const sent = []
let id = 0
const transport = new SafeSyncWebSocketTransport({
  send: async (action, payload, context) => sent.push({ action, payload, context }),
  requestId: () => `request-${++id}`,
  timeoutMs: 100,
})

const statusPromise = transport.request("SafeSyncStatus", { vault: "vault-a" })
assert.equal(sent[0].action, "SafeSyncStatus")
assert.equal(sent[0].context, "request-1")
assert.equal(transport.receive("SafeSyncStatus", { capability: true, state: "OFF" }), true)
assert.equal((await statusPromise).state, "OFF")

const rolePromise = transport.request("DeviceRoleRegister", { vault: "vault-a", role: "BIDIRECTIONAL" })
assert.equal(sent[1].action, "DeviceRoleRegister")
assert.equal(transport.receive("DeviceRoleStatus", { context: "request-2", role: "BIDIRECTIONAL", writable: true }), true)
assert.equal((await rolePromise).writable, true)

const mutationPromise = transport.request("SafeNoteMutation", { vault: "vault-a" })
assert.equal(transport.receive("SafeNoteMutationAck", { context: "wrong", resourceId: "r1" }), false)
assert.equal(transport.receive("SafeNoteMutationAck", { context: "request-3", resourceId: "r1" }), true)
assert.equal((await mutationPromise).resourceId, "r1")

const errorPromise = transport.request("SafeFolderMutation", { vault: "vault-a" })
assert.equal(transport.receive("SafeFolderMutationAck", {
  context: "request-4",
  safeSyncError: true,
  errorCode: "REVISION_CONFLICT",
  code: 534,
  message: "conflict",
}), true)
await assert.rejects(errorPromise, (error) => {
  assert.ok(error instanceof SafeSyncTransportError)
  assert.equal(error.errorCode, "REVISION_CONFLICT")
  return true
})

const timeoutTransport = new SafeSyncWebSocketTransport({
  send: async () => {},
  requestId: () => "timeout",
  timeoutMs: 5,
})
await assert.rejects(() => timeoutTransport.request("SafeSyncEvents", { vault: "vault-a" }), /timed out/)

console.log("safe sync websocket transport tests passed")
