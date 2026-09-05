import type { SDKMessage } from "@cursor/sdk"
import type { CursorPluginError } from "../errors.ts"

export type TurnEvent =
  | { readonly type: "raw"; readonly value: SDKMessage }
  | {
      readonly type: "response-metadata"
      readonly id: string
      readonly timestamp?: number
      readonly modelId?: string
    }
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
      readonly total: number
    }
  | {
      readonly type: "done"
      readonly reason: "stop" | "length" | "aborted"
      readonly metadata?: {
        readonly runId: string
        readonly requestId?: string
        readonly durationMs?: number
        readonly modelId?: string
        readonly git?: readonly {
          readonly repoUrl: string
          readonly branch?: string
          readonly prUrl?: string
        }[]
      }
    }
  | { readonly type: "failed"; readonly error: CursorPluginError }

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue }
type NonNullJsonValue = Exclude<JsonValue, null>

export function translate(message: SDKMessage): readonly TurnEvent[] {
  return translateMessage(message, new Map())
}

export function createMessageTranslator(): (message: SDKMessage) => readonly TurnEvent[] {
  const toolInputs = new Map<string, unknown>()
  return (message) => translateMessage(message, toolInputs)
}

function translateMessage(message: SDKMessage, toolInputs: Map<string, unknown>): readonly TurnEvent[] {
  switch (message.type) {
    case "assistant": {
      const events: TurnEvent[] = []
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.length > 0) {
          events.push({ type: "text", delta: block.text })
        }
        if (block.type === "tool_use") toolInputs.set(block.id, block.input)
      }
      return events
    }
    case "thinking":
      return message.text.length > 0 ? [{ type: "reasoning", delta: message.text }] : []
    case "tool_call": {
      if (message.status === "running") {
        if (message.args !== undefined && message.truncated?.args !== true) {
          toolInputs.set(message.call_id, message.args)
        }
        return []
      }
      const cachedInput = toolInputs.get(message.call_id)
      const hasCachedInput = toolInputs.has(message.call_id)
      toolInputs.delete(message.call_id)
      if (message.truncated?.args === true && !hasCachedInput) {
        return [
          {
            type: "failed",
            error: {
              kind: "agent-run-failed",
              detail: `Cursor truncated the input for tool call ${message.call_id}.`,
            },
          },
        ]
      }
      if (message.truncated?.result === true) {
        return [
          {
            type: "failed",
            error: {
              kind: "agent-run-failed",
              detail: `Cursor truncated the result for tool call ${message.call_id}.`,
            },
          },
        ]
      }
      const input = message.truncated?.args === true || message.args === undefined ? cachedInput : message.args
      const tool = nativeTool(message.name, input)
      const call: TurnEvent = {
        type: "tool-call",
        id: message.call_id,
        name: tool.name,
        input: tool.input,
      }
      const result = cursorResult(message.result)
      return [
        call,
        {
          type: "tool-result",
          id: message.call_id,
          name: tool.name,
          result: resultOutput(tool.name, result.value),
          isError: message.status === "error" || result.isError,
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
          total: message.usage.totalTokens ?? 0,
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

function nativeTool(name: string, value: unknown): { name: string; input: JsonValue } {
  const input = jsonValue(value)
  if (!isJsonObject(input)) return { name, input }
  if (name === "read" || name === "edit" || name === "write") {
    return { name, input: rename(input, "path", "filePath") }
  }
  if (name === "ls") return { name: "list", input }
  if (name === "glob") {
    return { name, input: rename(rename(input, "globPattern", "pattern"), "targetDirectory", "path") }
  }
  if (name === "grep") {
    let mapped = rename(input, "glob", "include")
    mapped = rename(mapped, "headLimit", "limit")
    if (typeof mapped.caseInsensitive === "boolean") {
      mapped = { ...mapped, caseSensitive: !mapped.caseInsensitive }
      delete mapped.caseInsensitive
    }
    return { name, input: mapped }
  }
  if (name === "updateTodos") return { name: "todowrite", input }
  if (name === "task") return { name, input: rename(input, "subagentType", "subagent_type") }
  return { name, input }
}

function rename(input: { [key: string]: JsonValue }, from: string, to: string): { [key: string]: JsonValue } {
  if (!(from in input)) return input
  const result = { ...input, [to]: input[from] ?? null }
  delete result[from]
  return result
}

function cursorResult(value: unknown): { value: JsonValue; isError: boolean } {
  const result = jsonValue(value)
  if (!isJsonObject(result) || typeof result.status !== "string") return { value: result, isError: false }
  const isError = result.status !== "success"
  if ("value" in result) return { value: result.value ?? null, isError }
  if (isError && "error" in result) return { value: result.error ?? "Tool call failed", isError: true }
  return { value: result, isError }
}

function resultOutput(name: string, value: JsonValue): NonNullJsonValue {
  return textOutput(name, value)
}

function textOutput(name: string, value: JsonValue): string {
  if (typeof value === "string") return value
  if (isJsonObject(value)) {
    if (name === "shell") {
      const stdout = typeof value.stdout === "string" ? value.stdout : ""
      const stderr = typeof value.stderr === "string" ? value.stderr : ""
      const text = stdout + stderr
      return text.length > 0 ? text : "(no output)"
    }
    if (name === "read" && typeof value.content === "string") return value.content
    if (name === "edit" && typeof value.diffString === "string") return value.diffString
    if (name === "glob" && Array.isArray(value.files)) return value.files.filter(isString).join("\n")
    if (name === "task" && typeof value.resultSuffix === "string") return value.resultSuffix
  }
  return JSON.stringify(value) ?? "null"
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: JsonValue): value is string {
  return typeof value === "string"
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
