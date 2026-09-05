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
      { type: "tool-call", id: "call", name: "edit", input: { filePath: "src/index.ts" } },
    ])
  })

  test("completed tools include their result", () => {
    expect(translate({ ...tool, status: "completed", result: { changed: true } })).toEqual([
      { type: "tool-call", id: "call", name: "edit", input: { filePath: "src/index.ts" } },
      {
        type: "tool-result",
        id: "call",
        name: "edit",
        result: { title: "edit", metadata: { changed: true }, output: '{"changed":true}' },
        isError: false,
      },
    ])
  })

  test("maps Cursor tool fields to native OpenCode fields", () => {
    expect(translate({ ...tool, name: "read", args: { path: "src/index.ts" } })).toEqual([
      { type: "tool-call", id: "call", name: "read", input: { filePath: "src/index.ts" } },
    ])
  })

  test("unwraps Cursor results into native text output", () => {
    expect(
      translate({
        ...tool,
        name: "shell",
        status: "completed",
        args: { command: "git status" },
        result: {
          status: "success",
          value: { exitCode: 0, signal: "", stdout: "working tree clean\n", stderr: "", executionTime: 10 },
        },
      }),
    ).toEqual([
      { type: "tool-call", id: "call", name: "shell", input: { command: "git status" } },
      {
        type: "tool-result",
        id: "call",
        name: "shell",
        result: {
          title: "shell",
          metadata: { exitCode: 0, signal: "", stdout: "working tree clean\n", stderr: "", executionTime: 10 },
          output: "working tree clean\n",
        },
        isError: false,
      },
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
