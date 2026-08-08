export type SafeMirrorDirection = "LOCAL_TO_REMOTE" | "REMOTE_TO_LOCAL"
export type SafeMirrorResourceType = "NOTE" | "FILE" | "FOLDER"

export interface SafeMirrorManifestItem {
  resourceType: SafeMirrorResourceType
  path: string
  contentHash: string
  size: number
  state?: "LIVE" | "DELETED"
  resourceId?: string
  resourceRevision?: number
}

export interface SafeMirrorPlanItem {
  action: "CREATE" | "UPDATE" | "DELETE" | "REPLACE"
  resourceType: SafeMirrorResourceType
  path: string
  source?: SafeMirrorManifestItem
  target?: SafeMirrorManifestItem
}

export interface SafeMirrorPlan {
  direction: SafeMirrorDirection
  creates: SafeMirrorPlanItem[]
  updates: SafeMirrorPlanItem[]
  deletes: SafeMirrorPlanItem[]
  replacements: SafeMirrorPlanItem[]
  unchanged: number
  sourceCount: number
  targetCount: number
  highRiskDelete: boolean
}

export function createSafeMirrorPlan(
  direction: SafeMirrorDirection,
  localItems: SafeMirrorManifestItem[],
  remoteItems: SafeMirrorManifestItem[],
): SafeMirrorPlan {
  const local = liveItemsByPath(localItems)
  const remote = liveItemsByPath(remoteItems)
  const source = direction === "LOCAL_TO_REMOTE" ? local : remote
  const target = direction === "LOCAL_TO_REMOTE" ? remote : local
  const plan: SafeMirrorPlan = {
    direction,
    creates: [],
    updates: [],
    deletes: [],
    replacements: [],
    unchanged: 0,
    sourceCount: source.size,
    targetCount: target.size,
    highRiskDelete: false,
  }

  for (const [path, sourceItem] of source) {
    const targetItem = target.get(path)
    if (!targetItem) {
      plan.creates.push({ action: "CREATE", resourceType: sourceItem.resourceType, path, source: sourceItem })
      continue
    }
    if (sourceItem.resourceType !== targetItem.resourceType) {
      plan.replacements.push({ action: "REPLACE", resourceType: sourceItem.resourceType, path, source: sourceItem, target: targetItem })
      continue
    }
    if (sameMirrorContent(sourceItem, targetItem)) {
      plan.unchanged++
      continue
    }
    plan.updates.push({ action: "UPDATE", resourceType: sourceItem.resourceType, path, source: sourceItem, target: targetItem })
  }

  for (const [path, targetItem] of target) {
    if (!source.has(path)) {
      plan.deletes.push({ action: "DELETE", resourceType: targetItem.resourceType, path, target: targetItem })
    }
  }
  const destructiveCount = plan.deletes.length + plan.replacements.length
  plan.highRiskDelete = destructiveCount >= 50 || (plan.targetCount > 0 && destructiveCount / plan.targetCount >= 0.1)
  return plan
}

export function safeMirrorPlanChangeCount(plan: SafeMirrorPlan): number {
  return plan.creates.length + plan.updates.length + plan.deletes.length + plan.replacements.length
}

export function compareSafeMirrorDeletionOrder(
  a: Pick<SafeMirrorManifestItem, "path" | "resourceType">,
  b: Pick<SafeMirrorManifestItem, "path" | "resourceType">,
): number {
  if (a.resourceType === "FOLDER" && b.resourceType !== "FOLDER") return 1
  if (a.resourceType !== "FOLDER" && b.resourceType === "FOLDER") return -1
  const depth = b.path.split("/").length - a.path.split("/").length
  return depth || b.path.localeCompare(a.path)
}

function liveItemsByPath(items: SafeMirrorManifestItem[]): Map<string, SafeMirrorManifestItem> {
  const result = new Map<string, SafeMirrorManifestItem>()
  for (const item of items) {
    if (!item.path || item.state === "DELETED") continue
    result.set(item.path, item)
  }
  return result
}

function sameMirrorContent(a: SafeMirrorManifestItem, b: SafeMirrorManifestItem): boolean {
  if (a.resourceType === "FOLDER") return true
  return a.contentHash === b.contentHash && a.size === b.size
}
