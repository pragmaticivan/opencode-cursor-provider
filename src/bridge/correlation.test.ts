import { describe, expect, test } from "bun:test"
import { asSessionID } from "../ids.ts"
import { decodeSentinel, encodeSentinel, extractScope, stampSystem } from "./correlation.ts"

const scope = { sessionID: asSessionID("ses_abc"), cwd: "/tmp/repo" }

describe("correlation sentinel", () => {
  test("round-trips session id and cwd", () => {
    expect(decodeSentinel(encodeSentinel(scope))).toEqual(scope)
  })

  test("unknown text is not a scope", () => {
    expect(decodeSentinel("hello")).toBeUndefined()
  })

  test("extract removes the marker from the system prompt", () => {
    const stamped = stampSystem(["be concise"], scope)
    const extracted = extractScope(stamped)
    expect(extracted.scope).toEqual(scope)
    expect(extracted.system).toEqual(["be concise"])
  })
})
