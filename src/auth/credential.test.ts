import { describe, expect, test } from "bun:test"
import { asApiKey, asEpochMs } from "../ids.ts"
import { fromHostCredential, oauthFromLogin } from "./credential.ts"

describe("fromHostCredential", () => {
  test("reads an oauth access token", () => {
    const parsed = fromHostCredential({
      type: "oauth",
      access: "cursor_abc",
      expires: 9_000,
      metadata: { email: "a@b.c" },
    })
    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: "oauth",
        apiKey: asApiKey("cursor_abc"),
        expiresAt: asEpochMs(9_000),
        email: "a@b.c",
      },
    })
  })

  test("rejects an empty key", () => {
    expect(oauthFromLogin({ apiKey: "   ", apiKeyExpiresAtMs: 1 }).ok).toBe(false)
  })

  test("oauth without expires stays usable as a key", () => {
    expect(fromHostCredential({ type: "oauth", access: "cursor_abc" })).toEqual({
      ok: true,
      value: { kind: "key", apiKey: asApiKey("cursor_abc") },
    })
  })

  test("oauth expires in seconds are converted to milliseconds", () => {
    const parsed = fromHostCredential({
      type: "oauth",
      access: "cursor_abc",
      expires: 1_800_000_000,
    })
    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: "oauth",
        apiKey: asApiKey("cursor_abc"),
        expiresAt: asEpochMs(1_800_000_000_000),
      },
    })
  })
})
