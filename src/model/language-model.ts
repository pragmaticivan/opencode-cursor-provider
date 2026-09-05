import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import type { ModelParameterValue } from "@cursor/sdk"
import type { SessionAgentBridge, TurnRequest } from "../bridge/bridge.ts"
import { extractScope } from "../bridge/correlation.ts"
import type { Conversation, ConversationTurn } from "../bridge/conversation.ts"
import type { TurnEvent } from "../bridge/translate.ts"
import { CursorPluginFailure, type CursorPluginError } from "../errors.ts"
import type { CatalogModelID } from "../ids.ts"

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
    if (message.content.some((part) => part.type === "file")) {
      refuse({ kind: "unsupported-request", reason: "file-input" })
    }
    if (message.role === "user" || message.role === "assistant") {
      const text = textOf(message.content)
      if (text.length > 0) turns.push({ role: message.role, text })
    }
  }

  const extracted = extractScope(system)
  const conversation: Conversation = { system: extracted.system, turns }
  return {
    modelID,
    scope: extracted.scope,
    conversation,
    ...(params === undefined ? {} : { params }),
    ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
      if (typeof part.text === "string") parts.push(part.text)
    }
  }
  return parts.join("")
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
      let usage = emptyUsage()
      let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined }
      let failed = false
      const tools = new Map<string, "called" | "completed">()
      try {
        for await (const event of events) {
          switch (event.type) {
            case "text":
              if (reasoningId) {
                controller.enqueue({ type: "reasoning-end", id: reasoningId })
                reasoningId = undefined
              }
              if (!textId) {
                textId = "text-1"
                controller.enqueue({ type: "text-start", id: textId })
              }
              controller.enqueue({ type: "text-delta", id: textId, delta: event.delta })
              break
            case "reasoning":
              if (textId) {
                controller.enqueue({ type: "text-end", id: textId })
                textId = undefined
              }
              if (!reasoningId) {
                reasoningId = "reasoning-1"
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
              break
            case "failed":
              failed = true
              controller.enqueue({ type: "error", error: new CursorPluginFailure(event.error) })
              break
            default: {
              const _exhaustive: never = event
              void _exhaustive
            }
          }
        }
        if (reasoningId) controller.enqueue({ type: "reasoning-end", id: reasoningId })
        if (textId) controller.enqueue({ type: "text-end", id: textId })
        if (failed) {
          controller.close()
          return
        }
        controller.enqueue({
          type: "finish",
          finishReason,
          usage,
        })
        controller.close()
      } catch (error) {
        controller.enqueue({ type: "error", error })
        controller.close()
      }
    },
    cancel() {
      abort.abort()
    },
  })
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
  return warnings
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
  }
}

function reasonFrom(reason: Extract<TurnEvent, { type: "done" }>["reason"]): LanguageModelV3FinishReason {
  if (reason === "stop") return { unified: "stop", raw: reason }
  if (reason === "length") return { unified: "length", raw: reason }
  return { unified: "other", raw: reason }
}
