import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3FilePart,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3ResponseMetadata,
  LanguageModelV3StreamPart,
  LanguageModelV3TextPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import type { ModelParameterValue } from "@cursor/sdk"
import type { SessionAgentBridge, TurnRequest } from "../bridge/bridge.ts"
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
import type { TurnEvent } from "../bridge/translate.ts"
import { CursorPluginFailure, type CursorPluginError } from "../errors.ts"
import type { CatalogModelID } from "../ids.ts"
import { parseCursorOptions } from "./provider-options.ts"

export function toLanguageModel(input: {
  bridge: SessionAgentBridge
  modelID: CatalogModelID
  wireID: string
  params?: readonly ModelParameterValue[]
}): LanguageModelV3 {
  const stream = (options: LanguageModelV3CallOptions) => {
    const coupled = coupleAbort(options.abortSignal)
    return toStreamParts(
      input.bridge.turn(parseCall({ ...options, abortSignal: coupled.signal }, input.modelID, input.params)),
      coupled.abort,
      warningsOf(options),
    )
  }

  return {
    specificationVersion: "v3",
    provider: "cursor",
    modelId: input.wireID,
    supportedUrls: {},
    doGenerate: async (options) => collectGenerate(stream(options)),
    doStream: async (options) => ({ stream: stream(options) }),
  }
}

function refuse(error: CursorPluginError): never {
  throw new CursorPluginFailure(error)
}

async function collectGenerate(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3GenerateResult> {
  const content: LanguageModelV3Content[] = []
  let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
  let usage = emptyUsage()
  let warnings: SharedV3Warning[] = []
  let response: LanguageModelV3ResponseMetadata | undefined
  let providerMetadata: LanguageModelV3GenerateResult["providerMetadata"]
  const reader = stream.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const part = next.value
      switch (part.type) {
        case "stream-start":
          warnings = part.warnings
          break
        case "text-delta":
          appendText(content, part.delta)
          break
        case "reasoning-delta":
          appendReasoning(content, part.delta)
          break
        case "tool-call":
        case "tool-result":
          content.push(part)
          break
        case "finish":
          finishReason = part.finishReason
          usage = part.usage
          providerMetadata = part.providerMetadata
          break
        case "response-metadata":
          response = {
            ...(part.id === undefined ? {} : { id: part.id }),
            ...(part.timestamp === undefined ? {} : { timestamp: part.timestamp }),
            ...(part.modelId === undefined ? {} : { modelId: part.modelId }),
          }
          break
        case "error":
          throw part.error
        default:
          break
      }
    }
    return {
      content,
      finishReason,
      usage,
      warnings,
      ...(response === undefined ? {} : { response }),
      ...(providerMetadata === undefined ? {} : { providerMetadata }),
    }
  } finally {
    await reader.cancel()
  }
}

function appendText(content: LanguageModelV3Content[], delta: string): void {
  const previous = content.at(-1)
  if (previous?.type === "text") {
    previous.text += delta
    return
  }
  content.push({ type: "text", text: delta })
}

function appendReasoning(content: LanguageModelV3Content[], delta: string): void {
  const previous = content.at(-1)
  if (previous?.type === "reasoning") {
    previous.text += delta
    return
  }
  content.push({ type: "reasoning", text: delta })
}

function parseCall(
  options: LanguageModelV3CallOptions,
  modelID: CatalogModelID,
  params: readonly ModelParameterValue[] | undefined,
): TurnRequest {
  if (options.tools !== undefined && options.tools.length > 0) {
    refuse({ kind: "unsupported-request", reason: "tools-requested" })
  }
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
  return {
    modelID,
    scope: extracted.scope,
    conversation,
    ...cursor,
    ...(options.includeRawChunks === true ? { includeRawChunks: true } : {}),
    ...(params === undefined ? {} : { params }),
    ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
  }
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

function toStreamParts(
  events: AsyncIterable<TurnEvent>,
  abort: AbortController,
  warnings: SharedV3Warning[],
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: "stream-start", warnings })
      let textId: string | undefined
      let reasoningId: string | undefined
      let textSequence = 0
      let reasoningSequence = 0
      let usage = emptyUsage()
      let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
      let doneMetadata: Extract<TurnEvent, { type: "done" }>["metadata"]
      const tools = new Map<string, "called" | "completed">()
      const closeOpenParts = () => {
        if (reasoningId) {
          controller.enqueue({ type: "reasoning-end", id: reasoningId })
          reasoningId = undefined
        }
        if (textId) {
          controller.enqueue({ type: "text-end", id: textId })
          textId = undefined
        }
      }
      try {
        for await (const event of events) {
          switch (event.type) {
            case "text":
              if (reasoningId) {
                controller.enqueue({ type: "reasoning-end", id: reasoningId })
                reasoningId = undefined
              }
              if (!textId) {
                textSequence += 1
                textId = `text-${textSequence}`
                controller.enqueue({ type: "text-start", id: textId })
              }
              controller.enqueue({ type: "text-delta", id: textId, delta: event.delta })
              break
            case "raw":
              controller.enqueue({ type: "raw", rawValue: event.value })
              break
            case "response-metadata":
              controller.enqueue({
                type: "response-metadata",
                id: event.id,
                ...(event.timestamp === undefined ? {} : { timestamp: new Date(event.timestamp) }),
                ...(event.modelId === undefined ? {} : { modelId: event.modelId }),
              })
              break
            case "reasoning":
              if (textId) {
                controller.enqueue({ type: "text-end", id: textId })
                textId = undefined
              }
              if (!reasoningId) {
                reasoningSequence += 1
                reasoningId = `reasoning-${reasoningSequence}`
                controller.enqueue({ type: "reasoning-start", id: reasoningId })
              }
              controller.enqueue({ type: "reasoning-delta", id: reasoningId, delta: event.delta })
              break
            case "tool-call":
              if (tools.has(event.id)) break
              if (reasoningId) {
                controller.enqueue({ type: "reasoning-end", id: reasoningId })
                reasoningId = undefined
              }
              if (textId) {
                controller.enqueue({ type: "text-end", id: textId })
                textId = undefined
              }
              controller.enqueue({
                type: "tool-call",
                toolCallId: event.id,
                toolName: event.name,
                input: JSON.stringify(event.input),
                providerExecuted: true,
                dynamic: true,
              })
              tools.set(event.id, "called")
              break
            case "tool-result":
              if (tools.get(event.id) === "completed") break
              controller.enqueue({
                type: "tool-result",
                toolCallId: event.id,
                toolName: event.name,
                result: event.result,
                isError: event.isError,
                dynamic: true,
              })
              tools.set(event.id, "completed")
              break
            case "usage":
              usage = usageFrom(event)
              break
            case "done":
              finishReason = reasonFrom(event.reason)
              doneMetadata = event.metadata
              break
            case "failed":
              closeOpenParts()
              controller.enqueue({ type: "error", error: new CursorPluginFailure(event.error) })
              controller.close()
              return
            default: {
              const _exhaustive: never = event
              void _exhaustive
            }
          }
        }
        closeOpenParts()
        const providerMetadata = finishMetadata(doneMetadata)
        controller.enqueue({
          type: "finish",
          finishReason,
          usage,
          ...(providerMetadata === undefined ? {} : { providerMetadata }),
        })
        controller.close()
      } catch (error) {
        closeOpenParts()
        controller.enqueue({ type: "error", error })
        controller.close()
      }
    },
    cancel() {
      abort.abort()
    },
  })
}

function finishMetadata(
  metadata: Extract<TurnEvent, { type: "done" }>["metadata"],
): LanguageModelV3GenerateResult["providerMetadata"] {
  if (metadata === undefined) return undefined
  return {
    cursor: {
      runId: metadata.runId,
      ...(metadata.requestId === undefined ? {} : { requestId: metadata.requestId }),
      ...(metadata.durationMs === undefined ? {} : { durationMs: metadata.durationMs }),
      ...(metadata.modelId === undefined ? {} : { modelId: metadata.modelId }),
      ...(metadata.git === undefined ? {} : { git: metadata.git.map((branch) => ({ ...branch })) }),
    },
  }
}

function coupleAbort(signal: AbortSignal | undefined): { signal: AbortSignal; abort: AbortController } {
  const abort = new AbortController()
  if (signal === undefined) return { signal: abort.signal, abort }
  if (signal.aborted) {
    abort.abort()
    return { signal, abort }
  }
  return { signal: AbortSignal.any([signal, abort.signal]), abort }
}

function warningsOf(options: LanguageModelV3CallOptions): SharedV3Warning[] {
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

const CURSOR_OPTIONS = new Set([
  "mode",
  "tools",
  "disallowedTools",
  "sandboxOptions",
  "autoReview",
  "settingSources",
])

function hasOptions(options: object | undefined): boolean {
  return options !== undefined && Object.keys(options).length > 0
}

function pushUnsupported(warnings: SharedV3Warning[], feature: string): void {
  if (warnings.some((warning) => warning.type === "unsupported" && warning.feature === feature)) return
  warnings.push({ type: "unsupported", feature })
}

function emptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

function usageFrom(event: Extract<TurnEvent, { type: "usage" }>): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: event.input,
      noCache: Math.max(0, event.input - event.cacheRead - event.cacheWrite),
      cacheRead: event.cacheRead,
      cacheWrite: event.cacheWrite,
    },
    outputTokens: {
      total: event.output,
      text: Math.max(0, event.output - event.reasoning),
      reasoning: event.reasoning,
    },
    raw: {
      inputTokens: event.input,
      outputTokens: event.output,
      cacheReadTokens: event.cacheRead,
      cacheWriteTokens: event.cacheWrite,
      reasoningTokens: event.reasoning,
      totalTokens: event.total,
    },
  }
}

function reasonFrom(reason: Extract<TurnEvent, { type: "done" }>["reason"]): LanguageModelV3FinishReason {
  if (reason === "stop") return { unified: "stop", raw: reason }
  if (reason === "length") return { unified: "length", raw: reason }
  return { unified: "other", raw: reason }
}
