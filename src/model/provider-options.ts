import type { JSONObject, JSONValue } from "@ai-sdk/provider"
import type { AgentModeOption, SettingSource, ToolName } from "@cursor/sdk"
import { CursorPluginFailure } from "../errors.ts"

export interface CursorAgentOptions {
  readonly tools?: readonly ToolName[]
  readonly disallowedTools?: readonly ToolName[]
  readonly sandboxOptions?: { readonly enabled: boolean }
  readonly autoReview?: boolean
  readonly settingSources?: readonly SettingSource[]
}

export interface CursorProviderOptions extends CursorAgentOptions {
  readonly mode?: AgentModeOption
}

export const CURSOR_PROVIDER_OPTION_NAMES = [
  "mode",
  "tools",
  "disallowedTools",
  "sandboxOptions",
  "autoReview",
  "settingSources",
] as const satisfies readonly (keyof CursorProviderOptions)[]

export interface ParsedCursorOptions {
  readonly mode?: AgentModeOption
  readonly agentOptions?: CursorAgentOptions
}

export function parseCursorOptions(cursor: JSONObject | undefined): ParsedCursorOptions {
  if (cursor === undefined) return {}
  const mode = parseMode(cursor.mode)
  const tools = stringList(cursor.tools)
  const disallowedTools = stringList(cursor.disallowedTools)
  const sandboxOptions = parseSandbox(cursor.sandboxOptions)
  const autoReview = optionalBoolean(cursor.autoReview)
  const settingSources = parseSettingSources(cursor.settingSources)
  const agentOptions = compactAgentOptions({
    ...(tools === undefined ? {} : { tools }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
    ...(sandboxOptions === undefined ? {} : { sandboxOptions }),
    ...(autoReview === undefined ? {} : { autoReview }),
    ...(settingSources === undefined ? {} : { settingSources }),
  })
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(agentOptions === undefined ? {} : { agentOptions }),
  }
}

function compactAgentOptions(input: CursorAgentOptions): CursorAgentOptions | undefined {
  return Object.keys(input).length === 0 ? undefined : input
}

function parseMode(value: JSONValue | undefined): AgentModeOption | undefined {
  if (value === undefined) return undefined
  if (value === "agent" || value === "plan") return value
  invalidOption()
}

function stringList(value: JSONValue | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) invalidOption()
  return [...value]
}

function parseSandbox(value: JSONValue | undefined): { readonly enabled: boolean } | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || Object.keys(value).length !== 1 || typeof value.enabled !== "boolean") invalidOption()
  return { enabled: value.enabled }
}

function optionalBoolean(value: JSONValue | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") invalidOption()
  return value
}

function parseSettingSources(value: JSONValue | undefined): readonly SettingSource[] | undefined {
  const sources = stringList(value)
  if (sources === undefined) return undefined
  const parsed: SettingSource[] = []
  for (const source of sources) {
    if (!isSettingSource(source)) invalidOption()
    parsed.push(source)
  }
  return parsed
}

function isSettingSource(value: string): value is SettingSource {
  switch (value) {
    case "project":
    case "user":
    case "team":
    case "mdm":
    case "plugins":
    case "all":
      return true
    default:
      return false
  }
}

function isObject(value: JSONValue): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidOption(): never {
  throw new CursorPluginFailure({ kind: "unsupported-request", reason: "provider-option" })
}
