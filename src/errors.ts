export type UnsupportedReason =
  | "tools-requested"
  | "tool-choice"
  | "structured-output"
  | "file-input"
  | "tool-result-content"
  | "provider-option"

export type CursorPluginError =
  | { readonly kind: "not-linked" }
  | { readonly kind: "unsupported-request"; readonly reason: UnsupportedReason }
  | { readonly kind: "agent-start-failed"; readonly detail: string }
  | { readonly kind: "agent-run-failed"; readonly detail: string }
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
      case "unsupported-request":
        return `Cursor cannot honor this request (${cause.reason}).`
      case "agent-start-failed":
        return `Cursor did not start: ${cause.detail}`
      case "agent-run-failed":
        return `Cursor failed mid-run: ${cause.detail}`
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
