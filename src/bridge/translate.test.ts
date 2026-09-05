import type { SDKAssistantMessage, SDKToolUseMessage } from "@cursor/sdk"
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
}

describe("translate", () => {
  test("assistant text becomes a text event", () => {
    expect(translate(assistant)).toEqual([{ type: "text", delta: "hello" }])
  })

  test("tool calls become reasoning, never tool events", () => {
    expect(translate(tool)).toEqual([{ type: "reasoning", delta: "Cursor used edit", origin: "tool-activity" }])
  })
})
