import type { SafeRevisionBaseline } from "../storage/safe_sync_state_store"
import type { SafeLocalManifestItem, SafeSyncEvent } from "./safe_sync_engine"

export interface SafeLocalChange {
  action: "CREATE" | "MODIFY" | "DELETE" | "RENAME"
  resourceType: "NOTE" | "FILE" | "FOLDER"
  path: string
  previousPath?: string
  contentHash: string
  size: number
}

export class SafeSyncLocalConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`safe sync found concurrent local and remote changes at: ${paths.join(", ")}`)
    this.name = "SafeSyncLocalConflictError"
  }
}

interface RawChange extends SafeLocalChange {
  kind: "create" | "modify" | "delete"
}

export function planSafeLocalChanges(
  localItems: SafeLocalManifestItem[],
  baselines: SafeRevisionBaseline[],
  remoteEvents: SafeSyncEvent[],
): SafeLocalChange[] {
  const local = uniqueByPath(localItems, "local manifest")
  const baseline = uniqueByPath(baselines, "safe sync baseline")
  const creates = new Map<string, RawChange>()
  const modifies = new Map<string, RawChange>()
  const deletes = new Map<string, RawChange>()

  for (const item of local.values()) {
    const confirmed = baseline.get(item.path)
    if (!confirmed || confirmed.state !== "LIVE") {
      creates.set(item.path, rawChange("create", "CREATE", item))
      continue
    }
    const resourceType = requireResourceType(confirmed)
    if (resourceType !== item.resourceType) {
      deletes.set(item.path, rawChange("delete", "DELETE", confirmed))
      creates.set(item.path, rawChange("create", "CREATE", item))
      continue
    }
    if (item.contentHash !== confirmed.contentHash || item.size !== confirmed.size) {
      modifies.set(item.path, rawChange("modify", "MODIFY", item))
    }
  }

  for (const confirmed of baseline.values()) {
    if (confirmed.state !== "LIVE" || local.has(confirmed.path)) continue
    deletes.set(confirmed.path, rawChange("delete", "DELETE", confirmed))
  }

  const rawChanges = [...creates.values(), ...modifies.values(), ...deletes.values()]
  const conflicts = rawChanges
    .filter((change) => remoteEvents.some((event) => overlapsRemoteEvent(change, event)))
    .map((change) => change.path)
  if (conflicts.length > 0) throw new SafeSyncLocalConflictError([...new Set(conflicts)].sort())

  const renames: SafeLocalChange[] = []
  inferFolderRenames(local, baseline, creates, deletes, renames)
  inferFileRenames(creates, deletes, renames)

  const collapsedDeletes = collapseFolderDeletes(deletes)
  const orderedDeletes = [...collapsedDeletes.values()].sort((left, right) => pathDepth(right.path) - pathDepth(left.path) || left.path.localeCompare(right.path))
  const orderedCreates = [...creates.values()].sort((left, right) => {
    if (left.resourceType === "FOLDER" && right.resourceType !== "FOLDER") return -1
    if (left.resourceType !== "FOLDER" && right.resourceType === "FOLDER") return 1
    return pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path)
  })
  const orderedModifies = [...modifies.values()].sort((left, right) => left.path.localeCompare(right.path))
  return [...renames, ...orderedDeletes, ...orderedCreates, ...orderedModifies].map(stripKind)
}

function inferFolderRenames(
  local: Map<string, SafeLocalManifestItem>,
  baselines: Map<string, SafeRevisionBaseline>,
  creates: Map<string, RawChange>,
  deletes: Map<string, RawChange>,
  renames: SafeLocalChange[],
): void {
  const sources = [...deletes.values()].filter((item) => item.resourceType === "FOLDER")
  const targets = [...creates.values()].filter((item) => item.resourceType === "FOLDER")
  const sourcesBySignature = groupBy(sources, (item) => treeSignature(item.path, baselines.values()))
  const targetsBySignature = groupBy(targets, (item) => treeSignature(item.path, local.values()))

  for (const source of sources.sort((left, right) => pathDepth(left.path) - pathDepth(right.path))) {
    if (!deletes.has(source.path)) continue
    const signature = treeSignature(source.path, baselines.values())
    const sourceMatches = sourcesBySignature.get(signature) || []
    const targetMatches = targetsBySignature.get(signature) || []
    if (sourceMatches.length !== 1 || targetMatches.length !== 1) continue
    const target = targetMatches[0]
    if (!creates.has(target.path)) continue
    renames.push({
      action: "RENAME",
      resourceType: "FOLDER",
      path: target.path,
      previousPath: source.path,
      contentHash: "",
      size: 0,
    })
    removeSubtree(deletes, source.path)
    removeSubtree(creates, target.path)
  }
}

function inferFileRenames(
  creates: Map<string, RawChange>,
  deletes: Map<string, RawChange>,
  renames: SafeLocalChange[],
): void {
  const candidates = (items: Iterable<RawChange>) => [...items].filter((item) => item.resourceType !== "FOLDER")
  const key = (item: RawChange) => `${item.resourceType}\u0000${item.contentHash}\u0000${item.size}`
  const sourcesBySignature = groupBy(candidates(deletes.values()), key)
  const targetsBySignature = groupBy(candidates(creates.values()), key)
  for (const [signature, sources] of sourcesBySignature) {
    const targets = targetsBySignature.get(signature) || []
    if (sources.length !== 1 || targets.length !== 1) continue
    const source = sources[0]
    const target = targets[0]
    if (!deletes.has(source.path) || !creates.has(target.path)) continue
    renames.push({
      action: "RENAME",
      resourceType: target.resourceType,
      path: target.path,
      previousPath: source.path,
      contentHash: target.contentHash,
      size: target.size,
    })
    deletes.delete(source.path)
    creates.delete(target.path)
  }
}

function collapseFolderDeletes(deletes: Map<string, RawChange>): Map<string, RawChange> {
  const collapsed = new Map(deletes)
  const folders = [...collapsed.values()]
    .filter((item) => item.resourceType === "FOLDER")
    .sort((left, right) => pathDepth(left.path) - pathDepth(right.path))
  for (const folder of folders) {
    if (!collapsed.has(folder.path)) continue
    for (const path of [...collapsed.keys()]) {
      if (path !== folder.path && isWithin(path, folder.path)) collapsed.delete(path)
    }
  }
  return collapsed
}

function overlapsRemoteEvent(change: RawChange, event: SafeSyncEvent): boolean {
  const remoteRoots = event.action === "RENAME" && event.previousPath
    ? [event.previousPath, event.path]
    : [event.path]
  if (remoteRoots.some((root) => change.path === root)) return true
  if (event.resourceType === "FOLDER" && (event.action === "DELETE" || event.action === "RENAME") &&
    remoteRoots.some((root) => isWithin(change.path, root))) return true
  return change.resourceType === "FOLDER" && change.kind === "delete" && remoteRoots.some((root) => isWithin(root, change.path))
}

function treeSignature(root: string, items: Iterable<SafeLocalManifestItem | SafeRevisionBaseline>): string {
  return [...items]
    .filter((item) => item.path === root || isWithin(item.path, root))
    .filter((item) => !("state" in item) || item.state === "LIVE")
    .map((item) => {
      const relativePath = item.path === root ? "." : item.path.slice(root.length + 1)
      return `${relativePath}\u0000${requireResourceType(item)}\u0000${item.contentHash}\u0000${item.size}`
    })
    .sort()
    .join("\u0001")
}

function rawChange(
  kind: RawChange["kind"],
  action: RawChange["action"],
  item: SafeLocalManifestItem | SafeRevisionBaseline,
): RawChange {
  return {
    kind,
    action,
    resourceType: requireResourceType(item),
    path: item.path,
    contentHash: item.contentHash,
    size: item.size,
  }
}

function requireResourceType(item: SafeLocalManifestItem | SafeRevisionBaseline): SafeLocalChange["resourceType"] {
  if (!item.resourceType) throw new Error(`safe sync baseline is missing resource type at ${item.path}`)
  return item.resourceType
}

function uniqueByPath<T extends { path: string }>(items: T[], label: string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    if (!item.path || item.path === "/") continue
    if (result.has(item.path)) throw new Error(`${label} contains duplicate path: ${item.path}`)
    result.set(item.path, item)
  }
  return result
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const value = key(item)
    grouped.set(value, [...(grouped.get(value) || []), item])
  }
  return grouped
}

function removeSubtree(items: Map<string, RawChange>, root: string): void {
  for (const path of [...items.keys()]) if (path === root || isWithin(path, root)) items.delete(path)
}

function isWithin(path: string, root: string): boolean {
  return path.startsWith(`${root}/`)
}

function pathDepth(path: string): number {
  return path.split("/").length
}

function stripKind(change: RawChange | SafeLocalChange): SafeLocalChange {
  const { action, resourceType, path, previousPath, contentHash, size } = change
  return { action, resourceType, path, ...(previousPath ? { previousPath } : {}), contentHash, size }
}
