import { describe, expect, test } from "bun:test"
import { PACKAGE_SPEC } from "./ids.ts"
import { model } from "./runtime.ts"

describe("native package contract", () => {
  test("catalog package is a supported AI SDK route", () => {
    expect(PACKAGE_SPEC).toBe("aisdk:@ai-sdk/openai-compatible")
  })

  test("model() refuses to run before the plugin binds", () => {
    expect(() => model("composer-2.5")).toThrow(/not loaded/)
  })
})
