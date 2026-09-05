import { describe, expect, test } from "bun:test"
import { asCatalogModelID } from "../ids.ts"
import { modelParamsFromOptions, parseListedModels, toCatalogVariants } from "./catalog.ts"

describe("parseListedModels", () => {
  test("reads a Cursor SDK list", () => {
    const listed = parseListedModels([
      { id: "gpt-5", displayName: "GPT-5" },
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ])
    expect(listed.map((model) => model.catalogID)).toEqual([
      asCatalogModelID("gpt-5"),
      asCatalogModelID("composer-2.5"),
      asCatalogModelID("auto"),
    ])
    expect(listed[0]?.name).toBe("GPT-5")
  })

  test("reads a wrapped items payload", () => {
    const listed = parseListedModels({
      items: [{ id: "sonnet-4", displayName: "Sonnet 4" }],
    })
    expect(listed.map((model) => model.catalogID)).toContain(asCatalogModelID("sonnet-4"))
  })

  test("empty input keeps the seed models", () => {
    expect(parseListedModels([]).map((model) => model.catalogID)).toEqual([
      asCatalogModelID("composer-2.5"),
      asCatalogModelID("auto"),
    ])
  })

  test("preserves model parameters and predefined variants", () => {
    const listed = parseListedModels([
      {
        id: "composer",
        displayName: "Composer",
        parameters: [{ id: "thinking", displayName: "Thinking", values: [{ value: "high" }] }],
        variants: [{ displayName: "High", params: [{ id: "thinking", value: "high" }], isDefault: true }],
      },
    ])

    expect(listed[0]?.parameters).toEqual([
      { id: "thinking", displayName: "Thinking", values: [{ value: "high" }] },
    ])
    const variants = toCatalogVariants(listed[0])
    expect(String(variants[0]?.id)).toBe("High")
    expect(variants[0]?.body).toEqual({ cursorModelParams: [{ id: "thinking", value: "high" }] })
  })
})

describe("modelParamsFromOptions", () => {
  test("reads Cursor params from OpenCode request options", () => {
    expect(modelParamsFromOptions({ cursorModelParams: [{ id: "thinking", value: "high" }] })).toEqual([
      { id: "thinking", value: "high" },
    ])
  })
})
