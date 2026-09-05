import { describe, expect, test } from "bun:test"
import { asCatalogModelID } from "../ids.ts"
import { parseListedModels } from "./catalog.ts"

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
})
