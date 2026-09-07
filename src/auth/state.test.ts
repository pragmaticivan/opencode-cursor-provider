import { describe, expect, test } from "bun:test"
import { asApiKey, asEpochMs, fail, ok } from "../ids.ts"
import { type CursorCredential } from "./credential.ts"
import { classify, reduce, usableKey, type AuthState } from "./state.ts"

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
    const credential = oauth(now + 60_000)
    const state = classify(credential, now)
    expect(state.status).toBe("linked")
    expect(usableKey(state)).toBe(asApiKey("cursor_live"))
  })

  test("oauth remains linked until expiry", () => {
    const credential = oauth(now + 1)
    const state = classify(credential, now)
    expect(state.status).toBe("linked")
    expect(usableKey(state)).toBe(asApiKey("cursor_live"))
  })

  test("expired oauth cannot yield a key", () => {
    const credential = oauth(now - 1)
    const state = classify(credential, now)
    expect(state.status).toBe("unlinked")
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
    const credential = oauth(now + 60_000)
    const next = reduce(unlinked, { type: "restore", stored: ok(credential), now })
    expect(next.status).toBe("linked")
  })

  test("tick unlinks expired oauth", () => {
    const expiresAt = now + 1
    let state = reduce(unlinked, { type: "restore", stored: ok(oauth(expiresAt)), now })
    expect(state.status).toBe("linked")

    state = reduce(state, { type: "tick", now: asEpochMs(expiresAt) })
    expect(state.status).toBe("unlinked")
    expect(usableKey(state)).toBeUndefined()
  })

  test("login-started clears the current credential", () => {
    const next = reduce(classify(key(), now), { type: "login-started" })
    expect(usableKey(next)).toBeUndefined()
  })

  test("login-succeeded stores the minted key", () => {
    const next = reduce(unlinked, {
      type: "login-succeeded",
      credential: oauth(later + 60_000),
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
