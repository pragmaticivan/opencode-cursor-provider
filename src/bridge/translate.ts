import type { SDKMessage } from "@cursor/sdk"
import type { CursorPluginError } from "../errors.ts"

export type TurnEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string; readonly origin: "thinking" | "tool-activity" }
  | { readonly type: "usage"; readonly input: number; readonly output: number }
  | { readonly type: "done"; readonly reason: "stop" | "length" | "aborted" }
  | { readonly type: "failed"; readonly error: CursorPluginError }

export function translate(message: SDKMessage): readonly TurnEvent[] {
  switch (message.type) {
    case "assistant": {
      const events: TurnEvent[] = []
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.length > 0) {
          events.push({ type: "text", delta: block.text })
        }
        if (block.type === "tool_use") {
          events.push({ type: "reasoning", delta: `Cursor used ${block.name}`, origin: "tool-activity" })
        }
      }
      return events
    }
    case "thinking":
      return message.text.length > 0 ? [{ type: "reasoning", delta: message.text, origin: "thinking" }] : []
    case "tool_call": {
      const label = message.status === "running" ? `Cursor used ${message.name}` : `Cursor finished ${message.name}`
      return [{ type: "reasoning", delta: label, origin: "tool-activity" }]
    }
    case "usage":
      return [
        {
          type: "usage",
          input: message.usage.inputTokens ?? 0,
          output: message.usage.outputTokens ?? 0,
        },
      ]
    case "status":
      if (message.status === "CANCELLED") return [{ type: "done", reason: "aborted" }]
      return []
    case "system":
    case "user":
    case "request":
    case "task":
      return []
    default: {
      const _exhaustive: never = message
      return _exhaustive
    }
  }
}
