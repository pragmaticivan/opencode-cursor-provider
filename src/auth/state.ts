import type { CursorApiKey, EpochMs, Parsed } from "../ids.ts"
import { credentialKey, type CursorCredential } from "./credential.ts"

export type AuthState =
  | { readonly status: "unlinked" }
  | { readonly status: "linked"; readonly credential: CursorCredential }

export type AuthEvent =
  | { readonly type: "restore"; readonly stored: Parsed<CursorCredential>; readonly now: EpochMs }
  | { readonly type: "login-started" }
  | { readonly type: "login-succeeded"; readonly credential: CursorCredential; readonly now: EpochMs }
  | { readonly type: "login-failed" }
  | { readonly type: "tick"; readonly now: EpochMs }
  | { readonly type: "rejected-by-cursor" }

export function classify(credential: CursorCredential, now: EpochMs): AuthState {
  if (credential.kind === "oauth" && now >= credential.expiresAt) return { status: "unlinked" }
  return { status: "linked", credential }
}

export function reduce(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "restore":
      if (!event.stored.ok) return { status: "unlinked" }
      return classify(event.stored.value, event.now)
    case "login-started":
      return { status: "unlinked" }
    case "login-succeeded":
      return classify(event.credential, event.now)
    case "login-failed":
      return { status: "unlinked" }
    case "tick":
      if (state.status === "linked") return classify(state.credential, event.now)
      return state
    case "rejected-by-cursor":
      return { status: "unlinked" }
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

export function usableKey(state: AuthState): CursorApiKey | undefined {
  if (state.status === "linked") return credentialKey(state.credential)
  return undefined
}
