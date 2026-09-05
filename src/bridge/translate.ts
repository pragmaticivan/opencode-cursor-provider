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
          const tool = nativeTool(block.name, block.input)
          events.push({ type: "tool-call", id: block.id, name: tool.name, input: tool.input })
        }
      }
      return events
    }
    case "thinking":
      return message.text.length > 0 ? [{ type: "reasoning", delta: message.text }] : []
    case "tool_call": {
      const tool = nativeTool(message.name, message.args)
      const call: TurnEvent = {
        type: "tool-call",
        id: message.call_id,
        name: tool.name,
        input: tool.input,
      }
      if (message.status === "running") return [call]
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
  if (result.status === "success" && "value" in result) return { value: result.value ?? null, isError: false }
  if (result.status === "error" && "error" in result) return { value: result.error ?? "Tool call failed", isError: true }
  return { value: result, isError: result.status === "error" }
}

function resultOutput(name: string, value: JsonValue): NonNullJsonValue {
  const metadata = isJsonObject(value) ? value : {}
  return {
    title: name,
    metadata,
    output: textOutput(name, value),
  }
}

function textOutput(name: string, value: JsonValue): string {
  if (typeof value === "string") return value
  if (isJsonObject(value)) {
    if (name === "shell") {
      const stdout = typeof value.stdout === "string" ? value.stdout : ""
      const stderr = typeof value.stderr === "string" ? value.stderr : ""
      if (stdout.length > 0 || stderr.length > 0) return stdout + stderr
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
