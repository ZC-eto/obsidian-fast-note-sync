import type { SafeSyncWriteMode } from "./safe_sync_runtime"

export function shouldIgnoreLegacyPush(writeMode: SafeSyncWriteMode, isInternalSafeUpload = false): boolean {
  return writeMode !== "legacy" && !isInternalSafeUpload
}
