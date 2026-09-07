import { describe, expect, test } from "bun:test"
import { asAgentID, asCatalogModelID, asSessionID } from "../ids.ts"
import { createBindingStore, route, type SessionAgentBinding, type TurnScope } from "./binding.ts"
import { checkpointOf, type Conversation } from "./conversation.ts"

const sessionID = asSessionID("ses_1")
const cwd = "/repo"
const scope: TurnScope = { sessionID, cwd }
const conversation: Conversation = {
  system: ["be brief"],
  turns: [
    { role: "user", parts: [{ type: "text", text: "one" }] },
    { role: "assistant", parts: [{ type: "text", text: "ok" }] },
    { role: "user", parts: [{ type: "text", text: "two" }] },
  ],
}
const binding: SessionAgentBinding = {
  sessionID,
  agentID: asAgentID("agent-1"),
  modelID: asCatalogModelID("composer-2.5"),
  cwd,
  checkpoint: checkpointOf(conversation),
  params: [{ id: "thinking", value: "high" }],
  mode: "agent",
  agentOptions: { tools: ["read"] },
}

describe("route", () => {
  test("missing scope is a one-shot", () => {
    expect(
      route({
        scope: undefined,
        binding,
        modelID: asCatalogModelID("composer-2.5"),
        conversation,
        params: binding.params,
        mode: binding.mode,
        agentOptions: binding.agentOptions,
      }),
    ).toBe("ONE_SHOT")
  })

  test("no binding starts a fresh agent", () => {
    expect(
      route({
        scope,
        binding: undefined,
        modelID: asCatalogModelID("composer-2.5"),
        conversation,
        params: binding.params,
        mode: binding.mode,
        agentOptions: binding.agentOptions,
      }),
    ).toBe("FRESH")
  })

  test("model switch starts a fresh agent", () => {
    expect(
      route({
        scope,
        binding,
        modelID: asCatalogModelID("auto"),
        conversation,
        params: binding.params,
        mode: binding.mode,
        agentOptions: binding.agentOptions,
      }),
    ).toBe("FRESH")
  })

  test("cwd change starts a fresh agent", () => {
    expect(
      route({
        scope: { sessionID, cwd: "/other" },
        binding,
        modelID: asCatalogModelID("composer-2.5"),
        conversation,
        params: binding.params,
        mode: binding.mode,
        agentOptions: binding.agentOptions,
      }),
    ).toBe("FRESH")
  })

  test("rewind or branch starts a fresh agent", () => {
    expect(
      route({
        scope,
        binding,
        modelID: asCatalogModelID("composer-2.5"),
        conversation,
        params: binding.params,
        mode: binding.mode,
        agentOptions: binding.agentOptions,
      }),
    ).toBe("FRESH")
  })

  test("a later user turn resumes", () => {
    expect(
      route({
        scope,
        binding,
        modelID: asCatalogModelID("composer-2.5"),
        conversation: {
          ...conversation,
          turns: [...conversation.turns, { role: "user", parts: [{ type: "text", text: "three" }] }],
        },
        params: binding.params,
        mode: binding.mode,
        agentOptions: binding.agentOptions,
      }),
    ).toBe("RESUME")
  })

  test("a changed earlier turn starts a fresh agent even with more user turns", () => {
    expect(
      route({
        scope,
        binding,
        modelID: binding.modelID,
        conversation: {
          ...conversation,
          turns: [
            { role: "user", parts: [{ type: "text", text: "one" }] },
            { role: "assistant", parts: [{ type: "text", text: "ok" }] },
            { role: "user", parts: [{ type: "text", text: "changed" }] },
            { role: "assistant", parts: [{ type: "text", text: "ok" }] },
            { role: "user", parts: [{ type: "text", text: "three" }] },
          ],
        },
        params: binding.params,
        mode: binding.mode,
        agentOptions: binding.agentOptions,
      }),
    ).toBe("FRESH")
  })

  test("a system or Cursor option change starts a fresh agent", () => {
    expect(
      route({
        scope,
        binding,
        modelID: binding.modelID,
        conversation: {
          ...conversation,
          system: ["be detailed"],
          turns: [...conversation.turns, { role: "user", parts: [{ type: "text", text: "three" }] }],
        },
        params: binding.params,
        mode: binding.mode,
        agentOptions: binding.agentOptions,
      }),
    ).toBe("FRESH")
    expect(
      route({
        scope,
        binding,
        modelID: binding.modelID,
        conversation: {
          ...conversation,
          turns: [...conversation.turns, { role: "user", parts: [{ type: "text", text: "three" }] }],
        },
        params: [{ id: "thinking", value: "low" }],
        mode: "plan",
        agentOptions: binding.agentOptions,
      }),
    ).toBe("FRESH")
    expect(
      route({
        scope,
        binding,
        modelID: binding.modelID,
        conversation: {
          ...conversation,
          turns: [...conversation.turns, { role: "user", parts: [{ type: "text", text: "three" }] }],
        },
        params: binding.params,
        mode: binding.mode,
        agentOptions: { tools: ["grep"] },
      }),
    ).toBe("FRESH")
  })

  test("tool option order does not start a fresh agent", () => {
    const orderedBinding = { ...binding, agentOptions: { tools: ["read", "grep"] } }
    expect(
      route({
        scope,
        binding: orderedBinding,
        modelID: binding.modelID,
        conversation: {
          ...conversation,
          turns: [...conversation.turns, { role: "user", parts: [{ type: "text", text: "three" }] }],
        },
        params: binding.params,
        mode: binding.mode,
        agentOptions: { tools: ["grep", "read"] },
      }),
    ).toBe("RESUME")
  })

  test("model parameter order does not start a fresh agent", () => {
    const orderedBinding = {
      ...binding,
      params: [
        { id: "a", value: "1" },
        { id: "b", value: "2" },
      ],
    }
    expect(
      route({
        scope,
        binding: orderedBinding,
        modelID: binding.modelID,
        conversation: {
          ...conversation,
          turns: [...conversation.turns, { role: "user", parts: [{ type: "text", text: "three" }] }],
        },
        params: [
          { id: "b", value: "2" },
          { id: "a", value: "1" },
        ],
        mode: binding.mode,
        agentOptions: binding.agentOptions,
      }),
    ).toBe("RESUME")
  })
})

describe("BindingStore", () => {
  test("put replaces the binding for a session", () => {
    const store = createBindingStore()
    store.put(binding)
    expect(store.get(sessionID)?.agentID).toBe(asAgentID("agent-1"))
    store.put({ ...binding, agentID: asAgentID("agent-2") })
    expect(store.get(sessionID)?.agentID).toBe(asAgentID("agent-2"))
    store.drop(sessionID)
    expect(store.get(sessionID)).toBeUndefined()
  })
})
