import type { CursorAgentID, EpochMs } from "./ids.ts"

export type UnsupportedReason =
  | "tools-requested"
  | "tool-choice"
  | "structured-output"
  | "multiple-completions"
  | "file-input"
  | "tool-result-content"
  | "provider-option"

export type CursorPluginError =
  | { readonly kind: "not-linked" }
  | { readonly kind: "credential-expired"; readonly expiredAt: EpochMs }
  | { readonly kind: "login-cancelled" }
  | { readonly kind: "login-failed"; readonly detail: string }
  | { readonly kind: "unsupported-request"; readonly reason: UnsupportedReason }
  | { readonly kind: "agent-start-failed"; readonly detail: string }
  | { readonly kind: "agent-run-failed"; readonly detail: string }
  | { readonly kind: "agent-lost"; readonly agentID: CursorAgentID }
  | { readonly kind: "model-unknown"; readonly modelID: string }
  | { readonly kind: "cancelled" }

export class CursorPluginFailure extends Error {
  override readonly cause: CursorPluginError

  constructor(cause: CursorPluginError) {
    super(CursorPluginFailure.message(cause))
    this.name = "CursorPluginFailure"
    this.cause = cause
  }

  static message(cause: CursorPluginError): string {
    switch (cause.kind) {
      case "not-linked":
        return "Cursor is not connected. Run /connect and choose Cursor."
      case "credential-expired":
        return "The Cursor login has expired. Run /connect again."
      case "login-cancelled":
        return "Cursor sign-in was cancelled."
      case "login-failed":
        return `Cursor sign-in failed: ${cause.detail}`
      case "unsupported-request":
        return `Cursor cannot honor this request (${cause.reason}).`
      case "agent-start-failed":
        return `Cursor did not start: ${cause.detail}`
      case "agent-run-failed":
        return `Cursor failed mid-run: ${cause.detail}`
      case "agent-lost":
        return `The Cursor agent ${cause.agentID} is gone. Starting a new one.`
      case "model-unknown":
        return `Unknown Cursor model: ${cause.modelID}`
      case "cancelled":
        return "The Cursor run was cancelled."
      default: {
        const _exhaustive: never = cause
        return _exhaustive
      }
    }
  }
}
