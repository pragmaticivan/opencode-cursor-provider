import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3TextPart,
  SharedV3Warning,
} from "@ai-sdk/provider"
import type { ModelParameterValue, SDKJsonValue } from "@cursor/sdk"
import type { TurnRequest } from "../bridge/bridge.ts"
import type { OpenCodeToolDefinition } from "../bridge/tool-bridge.ts"
import { extractScope } from "../bridge/correlation.ts"
import {
  canonicalJson,
  type AssistantPart,
  type Conversation,
  type ConversationTurn,
  type CursorImage,
  type ToolPart,
  type UserPart,
} from "../bridge/conversation.ts"
import { CursorPluginFailure, type CursorPluginError } from "../errors.ts"
import type { CatalogModelID } from "../ids.ts"
import { CURSOR_PROVIDER_OPTION_NAMES, parseCursorOptions } from "./provider-options.ts"

function refuse(error: CursorPluginError): never {
  throw new CursorPluginFailure(error)
}

export function parseCall(
  options: LanguageModelV3CallOptions,
  modelID: CatalogModelID,
  params: readonly ModelParameterValue[] | undefined,
): TurnRequest {
  if (options.toolChoice !== undefined && options.toolChoice.type !== "auto") {
    refuse({ kind: "unsupported-request", reason: "tool-choice" })
  }
  if (options.responseFormat?.type === "json") {
    refuse({ kind: "unsupported-request", reason: "structured-output" })
  }

  const system: string[] = []
  const turns: ConversationTurn[] = []
  for (const message of options.prompt) {
    if (message.role === "system") {
      system.push(message.content)
      continue
    }
    if (message.role === "user") {
      const parts = userParts(message.content)
      if (parts.length > 0) turns.push({ role: "user", parts })
      continue
    }
    if (message.role === "assistant") {
      const parts = assistantParts(message.content)
      if (parts.length > 0) turns.push({ role: "assistant", parts })
      continue
    }
    if (message.role === "tool") {
      const parts = toolParts(message.content)
      if (parts.length > 0) turns.push({ role: "tool", parts })
    }
  }

  const extracted = extractScope(system)
  const conversation: Conversation = { system: extracted.system, turns }
  const cursor = parseCursorOptions(options.providerOptions?.cursor)
  const tools = parseTools(options.tools)
  return {
    modelID,
    scope: extracted.scope,
    conversation,
    ...(tools.length === 0 ? {} : { tools }),
    ...cursor,
    ...(options.includeRawChunks === true ? { includeRawChunks: true } : {}),
    ...(params === undefined ? {} : { params }),
    ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
  }
}

function parseTools(tools: LanguageModelV3CallOptions["tools"]): OpenCodeToolDefinition[] {
  if (tools === undefined) return []
  const parsed: OpenCodeToolDefinition[] = []
  for (const tool of tools) {
    if (tool.type !== "function") refuse({ kind: "unsupported-request", reason: "tools-requested" })
    const inputSchema = sdkJsonValue(tool.inputSchema)
    if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
      refuse({ kind: "unsupported-request", reason: "tools-requested" })
    }
    parsed.push({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema,
    })
  }
  return parsed
}

function sdkJsonValue(value: unknown): SDKJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (Array.isArray(value)) return value.map(sdkJsonValue)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .map(([key, item]) => [key, sdkJsonValue(item)]),
    )
  }
  return String(value)
}

type AssistantContent = Extract<LanguageModelV3Message, { role: "assistant" }>["content"]
type ToolContent = Extract<LanguageModelV3Message, { role: "tool" }>["content"]

function assistantParts(content: AssistantContent): AssistantPart[] {
  const parts: AssistantPart[] = []
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text })
        break
      case "reasoning":
        parts.push({ type: "reasoning", text: part.text })
        break
      case "tool-call":
        parts.push({
          type: "tool-call",
          id: part.toolCallId,
          name: part.toolName,
          input: canonicalJson(part.input),
        })
        break
      case "tool-result": {
        const result = historyResult(part.output)
        parts.push({
          type: "tool-result",
          id: part.toolCallId,
          name: part.toolName,
          output: result.output,
          isError: result.isError,
        })
        break
      }
      case "file":
        refuse({ kind: "unsupported-request", reason: "file-input" })
      default: {
        const _exhaustive: never = part
        return _exhaustive
      }
    }
  }
  return parts
}

function toolParts(content: ToolContent): ToolPart[] {
  return content.map((part) => {
    if (part.type === "tool-result") {
      const result = historyResult(part.output)
      return {
        type: "tool-result",
        id: part.toolCallId,
        name: part.toolName,
        output: result.output,
        isError: result.isError,
      }
    }
    return {
      type: "tool-approval",
      id: part.approvalId,
      approved: part.approved,
      ...(part.reason === undefined ? {} : { reason: part.reason }),
    }
  })
}

function historyResult(output: Extract<ToolContent[number], { type: "tool-result" }>["output"]): {
  readonly output: readonly UserPart[]
  readonly isError: boolean
} {
  switch (output.type) {
    case "text":
      return { output: [{ type: "text", text: output.value }], isError: false }
    case "json":
      return { output: [{ type: "text", text: canonicalJson(output.value) }], isError: false }
    case "error-text":
      return { output: [{ type: "text", text: output.value }], isError: true }
    case "error-json":
      return { output: [{ type: "text", text: canonicalJson(output.value) }], isError: true }
    case "execution-denied":
      return { output: [{ type: "text", text: output.reason ?? "Execution denied" }], isError: true }
    case "content":
      return { output: toolOutputParts(output.value), isError: false }
    default: {
      const _exhaustive: never = output
      return _exhaustive
    }
  }
}

function toolOutputParts(
  content: Extract<Extract<ToolContent[number], { type: "tool-result" }>["output"], { type: "content" }>["value"],
): UserPart[] {
  const parts: UserPart[] = []
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text })
        break
      case "file-data":
      case "image-data":
        if (!part.mediaType.startsWith("image/") || part.mediaType === "image/*") {
          refuse({ kind: "unsupported-request", reason: "file-input" })
        }
        parts.push({ type: "image", image: { data: part.data, mimeType: part.mediaType } })
        break
      case "file-url":
      case "file-id":
      case "image-url":
      case "image-file-id":
        refuse({ kind: "unsupported-request", reason: "file-input" })
      case "custom":
        refuse({ kind: "unsupported-request", reason: "tool-result-content" })
      default: {
        const _exhaustive: never = part
        return _exhaustive
      }
    }
  }
  return parts
}

function userParts(content: readonly (LanguageModelV3TextPart | LanguageModelV3FilePart)[]): UserPart[] {
  const parts: UserPart[] = []
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text })
      continue
    }
    if (!part.mediaType.startsWith("image/") || part.mediaType === "image/*") {
      refuse({ kind: "unsupported-request", reason: "file-input" })
    }
    if (part.data instanceof URL) {
      refuse({ kind: "unsupported-request", reason: "file-input" })
    }
    const image: CursorImage = {
      data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64"),
      mimeType: part.mediaType,
    }
    parts.push({ type: "image", image })
  }
  return parts
}

export function warningsOf(options: LanguageModelV3CallOptions): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = []
  if (options.temperature !== undefined) warnings.push({ type: "unsupported", feature: "temperature" })
  if (options.topP !== undefined) warnings.push({ type: "unsupported", feature: "topP" })
  if (options.topK !== undefined) warnings.push({ type: "unsupported", feature: "topK" })
  if (options.maxOutputTokens !== undefined) warnings.push({ type: "unsupported", feature: "maxOutputTokens" })
  if (options.stopSequences !== undefined && options.stopSequences.length > 0) {
    warnings.push({ type: "unsupported", feature: "stopSequences" })
  }
  if (options.presencePenalty !== undefined) warnings.push({ type: "unsupported", feature: "presencePenalty" })
  if (options.frequencyPenalty !== undefined) warnings.push({ type: "unsupported", feature: "frequencyPenalty" })
  if (options.seed !== undefined) warnings.push({ type: "unsupported", feature: "seed" })
  if (options.headers !== undefined && Object.values(options.headers).some((value) => value !== undefined)) {
    warnings.push({ type: "unsupported", feature: "headers" })
  }
  for (const [provider, value] of Object.entries(options.providerOptions ?? {})) {
    if (Object.keys(value).length === 0) continue
    if (provider !== "cursor") {
      warnings.push({ type: "unsupported", feature: `providerOptions.${provider}` })
      continue
    }
    for (const option of Object.keys(value)) {
      if (!CURSOR_OPTIONS.has(option)) {
        warnings.push({ type: "unsupported", feature: `providerOptions.cursor.${option}` })
      }
    }
  }
  for (const message of options.prompt) {
    if (hasOptions(message.providerOptions)) pushUnsupported(warnings, "message.providerOptions")
    if (message.role === "system") continue
    for (const part of message.content) {
      if (hasOptions(part.providerOptions)) pushUnsupported(warnings, "content.providerOptions")
      if (part.type !== "tool-result") continue
      if ("providerOptions" in part.output && hasOptions(part.output.providerOptions)) {
        pushUnsupported(warnings, "content.providerOptions")
      }
      if (part.output.type !== "content") continue
      for (const output of part.output.value) {
        if (hasOptions(output.providerOptions)) pushUnsupported(warnings, "content.providerOptions")
      }
    }
  }
  return warnings
}

const CURSOR_OPTIONS = new Set<string>(CURSOR_PROVIDER_OPTION_NAMES)

function hasOptions(options: object | undefined): boolean {
  return options !== undefined && Object.keys(options).length > 0
}

function pushUnsupported(warnings: SharedV3Warning[], feature: string): void {
  if (warnings.some((warning) => warning.type === "unsupported" && warning.feature === feature)) return
  warnings.push({ type: "unsupported", feature })
}
