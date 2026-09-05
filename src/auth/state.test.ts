import { describe, expect, test } from "bun:test"
import { asApiKey, asEpochMs, fail, ok } from "../ids.ts"
import { type CursorCredential } from "./credential.ts"
import { WARN_WINDOW_MS, classify, reduce, usableKey, type AuthState } from "./state.ts"

const now = asEpochMs(1_000_000_000_000)
const later = asEpochMs(now + 60_000)

function oauth(expiresAt: number): CursorCredential {
  return {
    kind: "oauth",
    apiKey: asApiKey("cursor_live"),
    expiresAt: asEpochMs(expiresAt),
  }
}

function key(): CursorCredential {
  return { kind: "key", apiKey: asApiKey("cursor_pasted") }
}

describe("classify", () => {
  test("oauth far from expiry is linked and usable", () => {
    const credential = oauth(now + WARN_WINDOW_MS * 2)
    const state = classify(credential, now)
    expect(state.status).toBe("linked")
    expect(usableKey(state)).toBe(asApiKey("cursor_live"))
  })

  test("oauth inside the warn window is stale and still usable", () => {
    const credential = oauth(now + WARN_WINDOW_MS / 2)
    const state = classify(credential, now)
    expect(state.status).toBe("stale")
    expect(usableKey(state)).toBe(asApiKey("cursor_live"))
  })

  test("expired oauth cannot yield a key", () => {
    const credential = oauth(now - 1)
    const state = classify(credential, now)
    expect(state.status).toBe("expired")
    expect(usableKey(state)).toBeUndefined()
  })

  test("api key never expires", () => {
    const state = classify(key(), now)
    expect(state.status).toBe("linked")
    expect(usableKey(state)).toBe(asApiKey("cursor_pasted"))
  })
})

describe("reduce", () => {
  const unlinked: AuthState = { status: "unlinked" }

  test("restore of a bad store stays unlinked", () => {
    const next = reduce(unlinked, { type: "restore", stored: fail("missing"), now })
    expect(next.status).toBe("unlinked")
    expect(usableKey(next)).toBeUndefined()
  })

  test("restore of a live oauth becomes linked", () => {
    const credential = oauth(now + WARN_WINDOW_MS * 2)
    const next = reduce(unlinked, { type: "restore", stored: ok(credential), now })
    expect(next.status).toBe("linked")
  })

  test("tick moves linked oauth into stale then expired", () => {
    const expiresAt = now + WARN_WINDOW_MS + 1
    let state = reduce(unlinked, { type: "restore", stored: ok(oauth(expiresAt)), now })
    expect(state.status).toBe("linked")

    state = reduce(state, { type: "tick", now: asEpochMs(expiresAt - WARN_WINDOW_MS + 1) })
    expect(state.status).toBe("stale")
    expect(usableKey(state)).toBe(asApiKey("cursor_live"))

    state = reduce(state, { type: "tick", now: asEpochMs(expiresAt) })
    expect(state.status).toBe("expired")
    expect(usableKey(state)).toBeUndefined()
  })

  test("login-cancelled returns to unlinked", () => {
    const abort = new AbortController()
    const linking = reduce(unlinked, {
      type: "login-started",
      url: "https://cursor.com/login",
      abort,
      now,
    })
    expect(linking.status).toBe("linking")
    expect(usableKey(linking)).toBeUndefined()

    const next = reduce(linking, { type: "login-cancelled" })
    expect(next.status).toBe("unlinked")
  })

  test("login-succeeded stores the minted key", () => {
    const next = reduce(unlinked, {
      type: "login-succeeded",
      credential: oauth(later + WARN_WINDOW_MS * 2),
      now: later,
    })
    expect(usableKey(next)).toBe(asApiKey("cursor_live"))
  })

  test("rejected-by-cursor forgets the key", () => {
    const linked = classify(key(), now)
    const next = reduce(linked, { type: "rejected-by-cursor" })
    expect(next.status).toBe("unlinked")
    expect(usableKey(next)).toBeUndefined()
  })
})
