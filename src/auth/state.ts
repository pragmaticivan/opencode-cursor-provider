import { asEpochMs, type CursorApiKey, type EpochMs, type Parsed } from "../ids.ts"
import { credentialKey, renewalPolicy, type CursorCredential, type RenewalPolicy } from "./credential.ts"

export const WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export type AuthState =
  | { readonly status: "unlinked" }
  | {
      readonly status: "linking"
      readonly url: string
      readonly startedAt: EpochMs
      readonly abort: AbortController
    }
  | {
      readonly status: "linked"
      readonly credential: CursorCredential
      readonly renewal: RenewalPolicy
    }
  | {
      readonly status: "stale"
      readonly credential: CursorCredential
      readonly expiresAt: EpochMs
    }
  | { readonly status: "expired"; readonly expiredAt: EpochMs }
  | { readonly status: "failed"; readonly detail: string }

export type AuthEvent =
  | { readonly type: "restore"; readonly stored: Parsed<CursorCredential>; readonly now: EpochMs }
  | { readonly type: "login-started"; readonly url: string; readonly abort: AbortController; readonly now: EpochMs }
  | { readonly type: "login-succeeded"; readonly credential: CursorCredential; readonly now: EpochMs }
  | { readonly type: "login-failed"; readonly detail: string }
  | { readonly type: "login-cancelled" }
  | { readonly type: "tick"; readonly now: EpochMs }
  | { readonly type: "rejected-by-cursor" }
  | { readonly type: "unlink" }

export function classify(credential: CursorCredential, now: EpochMs): AuthState {
  if (credential.kind !== "oauth") {
    return { status: "linked", credential, renewal: renewalPolicy(credential) }
  }
  if (now >= credential.expiresAt) {
    return { status: "expired", expiredAt: credential.expiresAt }
  }
  if (now >= asEpochMs(credential.expiresAt - WARN_WINDOW_MS)) {
    return { status: "stale", credential, expiresAt: credential.expiresAt }
  }
  return { status: "linked", credential, renewal: renewalPolicy(credential) }
}

export function reduce(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "restore":
      if (!event.stored.ok) return { status: "unlinked" }
      return classify(event.stored.value, event.now)
    case "login-started":
      return {
        status: "linking",
        url: event.url,
        startedAt: event.now,
        abort: event.abort,
      }
    case "login-succeeded":
      return classify(event.credential, event.now)
    case "login-failed":
      return { status: "failed", detail: event.detail }
    case "login-cancelled":
      return { status: "unlinked" }
    case "tick":
      if (state.status === "linked" || state.status === "stale") {
        return classify(state.credential, event.now)
      }
      return state
    case "rejected-by-cursor":
      return { status: "unlinked" }
    case "unlink":
      return { status: "unlinked" }
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

export function usableKey(state: AuthState): CursorApiKey | undefined {
  if (state.status === "linked" || state.status === "stale") return credentialKey(state.credential)
  return undefined
}
