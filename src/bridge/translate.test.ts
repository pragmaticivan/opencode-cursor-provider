import type { SDKAssistantMessage, SDKThinkingMessage, SDKToolUseMessage, SDKUsageMessage } from "@cursor/sdk"
import { describe, expect, test } from "bun:test"
import { createMessageTranslator, translate } from "./translate.ts"

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

  test("assistant tool blocks wait for the final tool event", () => {
    expect(
      translate({
        ...assistant,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call", name: "read", input: {} }],
        },
      }),
    ).toEqual([])
  })

  test("thinking becomes reasoning", () => {
    expect(translate(thinking)).toEqual([{ type: "reasoning", delta: "Inspect the provider boundary." }])
  })

  test("running tools wait for their final input", () => {
    expect(translate(tool)).toEqual([])
  })

  test("completed tools include their result", () => {
    expect(translate({ ...tool, status: "completed", result: { changed: true } })).toEqual([
      { type: "tool-call", id: "call", name: "edit", input: { filePath: "src/index.ts" } },
      {
        type: "tool-result",
        id: "call",
        name: "edit",
        result: '{"changed":true}',
        isError: false,
      },
    ])
  })

  test("a terminal tool event uses complete arguments from an earlier update", () => {
    const translateMessage = createMessageTranslator()
    expect(translateMessage(tool)).toEqual([])
    expect(translateMessage({ ...tool, status: "completed", args: undefined, result: "ok" })[0]).toEqual({
      type: "tool-call",
      id: "call",
      name: "edit",
      input: { filePath: "src/index.ts" },
    })
  })

  test("rejects truncated tool input when no complete input exists", () => {
    const translateMessage = createMessageTranslator()
    expect(
      translateMessage({ ...tool, status: "completed", args: { path: "src" }, result: "ok", truncated: { args: true } }),
    ).toEqual([
      {
        type: "failed",
        error: { kind: "agent-run-failed", detail: "Cursor truncated the input for tool call call." },
      },
    ])
  })

  test("rejects truncated tool results", () => {
    expect(
      createMessageTranslator()({
        ...tool,
        status: "completed",
        result: "partial",
        truncated: { result: true },
      }),
    ).toEqual([
      {
        type: "failed",
        error: { kind: "agent-run-failed", detail: "Cursor truncated the result for tool call call." },
      },
    ])
  })

  test("maps Cursor tool fields to native OpenCode fields", () => {
    expect(
      translate({ ...tool, name: "read", status: "completed", args: { path: "src/index.ts" }, result: "ok" })[0],
    ).toEqual({ type: "tool-call", id: "call", name: "read", input: { filePath: "src/index.ts" } })
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
        result: "working tree clean\n",
        isError: false,
      },
    ])
  })

  test("unwraps failed Cursor shell results into stderr text", () => {
    expect(
      translate({
        ...tool,
        name: "shell",
        status: "completed",
        args: { command: "git status" },
        result: {
          status: "failure",
          value: {
            exitCode: 128,
            signal: "",
            stdout: "",
            stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
            executionTime: 3104,
          },
        },
      }),
    ).toEqual([
      { type: "tool-call", id: "call", name: "shell", input: { command: "git status" } },
      {
        type: "tool-result",
        id: "call",
        name: "shell",
        result: "fatal: not a git repository (or any of the parent directories): .git\n",
        isError: true,
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
        total: 140,
      },
    ])
  })
})
