import { describe, expect, test } from "bun:test"
import { asAgentID, asCatalogModelID, asEpochMs, asSessionID } from "../ids.ts"
import { createBindingStore, route, type SessionAgentBinding, type TurnScope } from "./binding.ts"

const sessionID = asSessionID("ses_1")
const cwd = "/repo"
const scope: TurnScope = { sessionID, cwd }
const binding: SessionAgentBinding = {
  sessionID,
  agentID: asAgentID("agent-1"),
  modelID: asCatalogModelID("composer-2.5"),
  cwd,
  forwardedTurns: 2,
  lastUsedAt: asEpochMs(1),
}

describe("route", () => {
  test("missing scope is a one-shot", () => {
    expect(
      route({
        scope: undefined,
        binding,
        modelID: asCatalogModelID("composer-2.5"),
        userTurns: 3,
      }),
    ).toBe("ONE_SHOT")
  })

  test("no binding starts a fresh agent", () => {
    expect(
      route({
        scope,
        binding: undefined,
        modelID: asCatalogModelID("composer-2.5"),
        userTurns: 1,
      }),
    ).toBe("FRESH")
  })

  test("model switch starts a fresh agent", () => {
    expect(
      route({
        scope,
        binding,
        modelID: asCatalogModelID("auto"),
        userTurns: 3,
      }),
    ).toBe("FRESH")
  })

  test("cwd change starts a fresh agent", () => {
    expect(
      route({
        scope: { sessionID, cwd: "/other" },
        binding,
        modelID: asCatalogModelID("composer-2.5"),
        userTurns: 3,
      }),
    ).toBe("FRESH")
  })

  test("rewind or branch starts a fresh agent", () => {
    expect(
      route({
        scope,
        binding,
        modelID: asCatalogModelID("composer-2.5"),
        userTurns: 2,
      }),
    ).toBe("FRESH")
  })

  test("a later user turn resumes", () => {
    expect(
      route({
        scope,
        binding,
        modelID: asCatalogModelID("composer-2.5"),
        userTurns: 3,
      }),
    ).toBe("RESUME")
  })
})

describe("BindingStore", () => {
  test("put replaces the binding for a session", () => {
    const store = createBindingStore()
    store.put(binding)
    expect(store.get(sessionID)?.agentID).toBe(asAgentID("agent-1"))
    store.put({ ...binding, agentID: asAgentID("agent-2"), forwardedTurns: 4 })
    expect(store.get(sessionID)?.agentID).toBe(asAgentID("agent-2"))
    store.drop(sessionID)
    expect(store.get(sessionID)).toBeUndefined()
  })
})
