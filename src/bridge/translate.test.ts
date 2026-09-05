import type { SDKAssistantMessage, SDKThinkingMessage, SDKToolUseMessage, SDKUsageMessage } from "@cursor/sdk"
import { describe, expect, test } from "bun:test"
import { translate } from "./translate.ts"

const assistant: SDKAssistantMessage = {
  type: "assistant",
  agent_id: "agent",
  run_id: "run",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
}

const tool: SDKToolUseMessage = {
  type: "tool_call",
  agent_id: "agent",
  run_id: "run",
  call_id: "call",
  name: "edit",
  status: "running",
  args: { path: "src/index.ts" },
}

const thinking: SDKThinkingMessage = {
  type: "thinking",
  agent_id: "agent",
  run_id: "run",
  text: "Inspect the provider boundary.",
}

const usage: SDKUsageMessage = {
  type: "usage",
  agent_id: "agent",
  run_id: "run",
  usage: {
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    totalTokens: 140,
    reasoningTokens: 15,
  },
}

describe("translate", () => {
  test("assistant text becomes a text event", () => {
    expect(translate(assistant)).toEqual([{ type: "text", delta: "hello" }])
  })

  test("thinking becomes reasoning", () => {
    expect(translate(thinking)).toEqual([{ type: "reasoning", delta: "Inspect the provider boundary." }])
  })

  test("running tools retain their identity and input", () => {
    expect(translate(tool)).toEqual([
      { type: "tool-call", id: "call", name: "edit", input: { path: "src/index.ts" } },
    ])
  })

  test("completed tools include their result", () => {
    expect(translate({ ...tool, status: "completed", result: { changed: true } })).toEqual([
      { type: "tool-call", id: "call", name: "edit", input: { path: "src/index.ts" } },
      { type: "tool-result", id: "call", name: "edit", result: { changed: true }, isError: false },
    ])
  })

  test("usage retains cache and reasoning tokens", () => {
    expect(translate(usage)).toEqual([
      {
        type: "usage",
        input: 100,
        output: 40,
        cacheRead: 20,
        cacheWrite: 10,
        reasoning: 15,
      },
    ])
  })
})
