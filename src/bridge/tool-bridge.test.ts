import { expect, test } from "bun:test"
import { createOpenCodeToolBridge } from "./tool-bridge.ts"

test("bridges a Cursor custom tool call to an OpenCode tool result", async () => {
  const bridge = createOpenCodeToolBridge([
    {
      name: "docs_search",
      description: "Search the documentation",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ], "bridge")

  const result = bridge.customTools.opencode__docs_search?.execute(
    { query: "Cursor" },
    { toolCallId: "cursor-call" },
  )
  await bridge.waitForCalls()

  expect(bridge.takeCalls()).toEqual([
    { id: "bridge-1", name: "docs_search", input: { query: "Cursor" } },
  ])
  bridge.resolve([
    {
      id: "bridge-1",
      output: [{ type: "text", text: "Cursor documentation" }],
      isError: false,
    },
  ])

  expect(await result).toEqual({ content: [{ type: "text", text: "Cursor documentation" }] })
})

test("namespaces OpenCode tools away from Cursor native tools", () => {
  const bridge = createOpenCodeToolBridge([
    { name: "read", inputSchema: { type: "object" } },
    { name: "docs_search", inputSchema: { type: "object" } },
  ])

  expect(Object.keys(bridge.customTools)).toEqual(["opencode__read", "opencode__docs_search"])
})

test("resolves parallel calls by bridge-owned ID", async () => {
  const bridge = createOpenCodeToolBridge(
    [{ name: "docs_search", inputSchema: { type: "object" } }],
    "bridge",
  )
  const first = bridge.customTools.opencode__docs_search?.execute(
    { query: "one" },
    { toolCallId: "same-cursor-id" },
  )
  const second = bridge.customTools.opencode__docs_search?.execute(
    { query: "two" },
    { toolCallId: "same-cursor-id" },
  )
  await bridge.waitForCalls()
  const calls = bridge.takeCalls()

  expect(calls.map((call) => call.id)).toEqual(["bridge-1", "bridge-2"])
  bridge.resolve([
    { id: "bridge-2", output: [{ type: "text", text: "second" }], isError: false },
    { id: "bridge-1", output: [{ type: "text", text: "first" }], isError: false },
  ])

  expect(await Promise.all([first, second])).toEqual([
    { content: [{ type: "text", text: "first" }] },
    { content: [{ type: "text", text: "second" }] },
  ])
})
