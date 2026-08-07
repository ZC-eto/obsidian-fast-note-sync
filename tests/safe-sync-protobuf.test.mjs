import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import esbuild from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const mapperBuild = await esbuild.build({
  entryPoints: [path.join(root, "src", "pb", "protobuf_mapper.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2020",
  write: false,
});
const mapperSource = Buffer.from(mapperBuild.outputFiles[0].contents).toString("base64");
const mapper = await import(`data:text/javascript;base64,${mapperSource}`);
const { proto } = await import(pathToFileURL(path.join(root, "src", "pb", "v1", "sync.js")).href);

const requestWire = mapper.enSendDTOToProtobuf("SafeSyncBootstrapCommit", {
  vault: "vault-a",
  sessionId: "session-a",
  manifestHash: "manifest-a",
  snapshotVaultRevision: 17,
  context: "ctx-a",
});
const requestEnvelope = proto.v1.WSMessage.decode(requestWire);
assert.equal(requestEnvelope.type, "SafeSyncBootstrapCommit");
const request = proto.v1.SafeSyncBootstrapCommitRequest.decode(requestEnvelope.data);
assert.equal(request.vault, "vault-a");
assert.equal(request.snapshotVaultRevision.toString(), "17");

const fileMutationWire = mapper.enSendDTOToProtobuf("SafeFileMutation", {
  vault: "vault-a",
  deviceId: "device-a",
  operationId: "op-file-delete",
  resourceId: "resource-file",
  baseRevision: 3,
  expectedPathState: "LIVE",
  action: "DELETE",
  path: "asset.bin",
  pathHash: "path-file",
});
const fileMutationEnvelope = proto.v1.WSMessage.decode(fileMutationWire);
const fileMutation = proto.v1.SafeMutationRequest.decode(fileMutationEnvelope.data);
assert.equal(fileMutation.operationId, "op-file-delete");
assert.equal(fileMutation.action, "DELETE");

const statusPayload = proto.v1.SafeSyncStatusResponse.encode({
  capability: true,
  state: "STRICT",
  latestVaultRevision: 21,
  migrationVerified: true,
  uid: 3,
  vaultId: 9,
}).finish();
const statusResponse = buildResponse("SafeSyncStatus", 1, true, statusPayload);
const decodedStatus = mapper.deReceivePacket(statusResponse);
assert.equal(decodedStatus.data.capability, true);
assert.equal(decodedStatus.data.state, "STRICT");
assert.equal(decodedStatus.data.latestVaultRevision, 21);
assert.equal(decodedStatus.data.uid, 3);
assert.equal(decodedStatus.data.vaultId, 9);

const eventPayload = proto.v1.SafeSyncEvent.encode({
  vaultRevision: 22,
  resourceId: "resource-a",
  resourceRevision: 8,
  resourceType: "NOTE",
  action: "MODIFY",
  path: "a.md",
  contentHash: "hash-b",
  state: "LIVE",
}).finish();
const eventResponse = buildResponse("SafeSyncEvent", 1, true, eventPayload);
const decodedEvent = mapper.deReceivePacket(eventResponse);
assert.equal(decodedEvent.data.vaultRevision, 22);
assert.equal(decodedEvent.data.resourceId, "resource-a");
assert.equal(decodedEvent.data.contentHash, "hash-b");

const errorPayload = proto.v1.SafeSyncErrorData.encode({
  errorCode: "REVISION_CONFLICT",
  resourceId: "resource-a",
  expectedRevision: 7,
  actualRevision: 8,
}).finish();
const errorResponse = buildResponse("SafeNoteMutationAck", 534, false, errorPayload);
const decodedError = mapper.deReceivePacket(errorResponse);
assert.equal(decodedError.code, 534);
assert.equal(decodedError.data.errorCode, "REVISION_CONFLICT");
assert.equal(decodedError.data.actualRevision, 8);

function buildResponse(action, code, status, data) {
  const response = proto.v1.WSResponse.encode({ code, status, data }).finish();
  return proto.v1.WSMessage.encode({ type: action, data: response }).finish();
}
