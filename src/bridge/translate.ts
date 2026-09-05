import type { SDKMessage } from "@cursor/sdk"
import type { CursorPluginError } from "../errors.ts"

export type TurnEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "reasoning"; readonly delta: string }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly input: JsonValue }
  | {
      readonly type: "tool-result"
      readonly id: string
      readonly name: string
      readonly result: NonNullJsonValue
      readonly isError: boolean
    }
  | {
      readonly type: "usage"
      readonly input: number
      readonly output: number
      readonly cacheRead: number
      readonly cacheWrite: number
      readonly reasoning: number
    }
  | { readonly type: "done"; readonly reason: "stop" | "length" | "aborted" }
  | { readonly type: "failed"; readonly error: CursorPluginError }

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue }
type NonNullJsonValue = Exclude<JsonValue, null>

export function translate(message: SDKMessage): readonly TurnEvent[] {
  switch (message.type) {
    case "assistant": {
      const events: TurnEvent[] = []
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.length > 0) {
          events.push({ type: "text", delta: block.text })
        }
        if (block.type === "tool_use") {
          events.push({ type: "tool-call", id: block.id, name: block.name, input: jsonValue(block.input) })
        }
      }
      return events
    }
    case "thinking":
      return message.text.length > 0 ? [{ type: "reasoning", delta: message.text }] : []
    case "tool_call": {
      const call: TurnEvent = {
        type: "tool-call",
        id: message.call_id,
        name: message.name,
        input: jsonValue(message.args),
      }
      if (message.status === "running") return [call]
      return [
        call,
        {
          type: "tool-result",
          id: message.call_id,
          name: message.name,
          result: nonNullJsonValue(message.result),
          isError: message.status === "error",
        },
      ]
    }
    case "usage":
      return [
        {
          type: "usage",
          input: message.usage.inputTokens ?? 0,
          output: message.usage.outputTokens ?? 0,
          cacheRead: message.usage.cacheReadTokens ?? 0,
          cacheWrite: message.usage.cacheWriteTokens ?? 0,
          reasoning: message.usage.reasoningTokens ?? 0,
        },
      ]
    case "status":
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

function nonNullJsonValue(value: unknown): NonNullJsonValue {
  return jsonValue(value) ?? "null"
}

function jsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value !== "object") return value === undefined ? null : String(value)
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, seen))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, seen)]))
}
