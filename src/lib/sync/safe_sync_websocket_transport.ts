import type { SafeSyncRequestAction, SafeSyncTransport } from "./safe_sync_engine"

export interface SafeSyncWebSocketSender {
  send(action: SafeSyncRequestAction, payload: Record<string, unknown>, context: string): Promise<void>
  requestId(): string
  timeoutMs?: number
}

interface PendingRequest {
  context: string
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
  timer: number
}

export class SafeSyncTransportError extends Error {
  constructor(
    readonly errorCode: string,
    readonly code: number,
    message: string,
    readonly details: string = "",
  ) {
    super(message || errorCode || `safe sync request failed with code ${code}`)
    this.name = "SafeSyncTransportError"
  }
}

export class SafeSyncWebSocketTransport implements SafeSyncTransport {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly timeoutMs: number

  constructor(private readonly sender: SafeSyncWebSocketSender) {
    this.timeoutMs = sender.timeoutMs || 30_000
  }

  request(action: SafeSyncRequestAction, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const responseAction = responseActionFor(action)
    if (this.pending.has(responseAction)) {
      return Promise.reject(new Error(`safe sync request already pending for ${responseAction}`))
    }
    const context = this.sender.requestId()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(responseAction)
        reject(new Error(`safe sync request timed out: ${action}`))
      }, this.timeoutMs)
      this.pending.set(responseAction, { context, resolve, reject, timer })
      void this.sender.send(action, payload, context).catch((error: unknown) => {
        const current = this.pending.get(responseAction)
        if (!current || current.context !== context) return
        window.clearTimeout(current.timer)
        this.pending.delete(responseAction)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  receive(action: string, payload: unknown): boolean {
    const pending = this.pending.get(action)
    if (!pending || !payload || typeof payload !== "object" || Array.isArray(payload)) return false
    const data = payload as Record<string, unknown>
    const context = typeof data.context === "string" ? data.context : ""
    if (context && context !== pending.context) return false
    window.clearTimeout(pending.timer)
    this.pending.delete(action)
    if (data.safeSyncError === true) {
      pending.reject(new SafeSyncTransportError(
        typeof data.errorCode === "string" ? data.errorCode : "SAFE_SYNC_ERROR",
        Number.isSafeInteger(data.code) ? Number(data.code) : 0,
        typeof data.message === "string" ? data.message : "",
        typeof data.details === "string" ? data.details : "",
      ))
    } else {
      pending.resolve(data)
    }
    return true
  }

  close(reason: string = "safe sync transport closed"): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }
}

function responseActionFor(action: SafeSyncRequestAction): string {
  switch (action) {
    case "SafeSyncStatus": return "SafeSyncStatus"
    case "SafeSyncBootstrapStart": return "SafeSyncBootstrapStartAck"
    case "SafeSyncBootstrapPage": return "SafeSyncBootstrapPageAck"
    case "SafeSyncBootstrapCommit": return "SafeSyncBootstrapCommitAck"
    case "SafeSyncBootstrapCancel": return "SafeSyncBootstrapCancelAck"
    case "SafeSyncEvents": return "SafeSyncEventsAck"
    case "SafeNoteMutation": return "SafeNoteMutationAck"
    case "SafeFolderMutation": return "SafeFolderMutationAck"
    case "SafeFileMutation": return "SafeFileMutationAck"
    case "SafeFileUploadStart": return "SafeFileUploadStartAck"
    case "SafeFileUploadCommit": return "SafeFileUploadCommitAck"
    case "DeviceRoleRegister": return "DeviceRoleStatus"
  }
}
