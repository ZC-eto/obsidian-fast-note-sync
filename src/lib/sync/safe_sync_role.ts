export type SyncRole = "bidirectional" | "local-publisher" | "remote-mirror"

export interface SyncRoleConflictSettings {
  readonlySyncEnabled: boolean
  offlineDeleteSyncEnabled: boolean
}

export function applySyncRoleSettingConflicts(settings: SyncRoleConflictSettings, role: SyncRole): boolean {
  const readonlySyncEnabled = role === "remote-mirror"
  const offlineDeleteSyncEnabled = role === "remote-mirror" ? false : settings.offlineDeleteSyncEnabled
  const changed = settings.readonlySyncEnabled !== readonlySyncEnabled || settings.offlineDeleteSyncEnabled !== offlineDeleteSyncEnabled
  settings.readonlySyncEnabled = readonlySyncEnabled
  settings.offlineDeleteSyncEnabled = offlineDeleteSyncEnabled
  return changed
}

export function isReadonlySyncManagedByRole(_role: SyncRole): boolean {
  return true
}

export function isOfflineDeleteSyncManagedByRole(role: SyncRole): boolean {
  return role === "remote-mirror"
}
