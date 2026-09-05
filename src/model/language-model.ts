import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type { SessionAgentBridge } from "../bridge/bridge.ts"
import { extractScope } from "../bridge/correlation.ts"
import type { Conversation, ConversationTurn } from "../bridge/conversation.ts"
import type { TurnEvent } from "../bridge/translate.ts"
import { CursorPluginFailure, type CursorPluginError } from "../errors.ts"
import { asCatalogModelID, type CatalogModelID } from "../ids.ts"

export function toLanguageModel(input: {
  bridge: SessionAgentBridge
  modelID: CatalogModelID
  wireID: string
}): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "cursor",
    modelId: input.wireID,
    supportedUrls: {},
    doGenerate: async (options) => {
      const parts: LanguageModelV3StreamPart[] = []
      const { stream } = await toLanguageModel(input).doStream(options)
      const reader = stream.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        parts.push(next.value)
      }
      const text = parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
      const finish = parts.find((part) => part.type === "finish")
      return {
        content: text.length > 0 ? [{ type: "text", text }] : [],
        finishReason: finish && finish.type === "finish" ? finish.finishReason : stopped(),
        usage: finish && finish.type === "finish" ? finish.usage : emptyUsage(),
        warnings: [],
      }
    },
    doStream: async (options) => ({
      stream: toStreamParts(input.bridge.turn(toTurnRequest(options, input.modelID))),
    }),
  }
}

export function toTurnRequest(
  options: LanguageModelV3CallOptions,
  modelID: CatalogModelID,
): import("../bridge/bridge.ts").TurnRequest {
  return parseCall(options, modelID)
}

function refuse(error: CursorPluginError): never {
  throw new CursorPluginFailure(error)
}

function parseCall(
  options: LanguageModelV3CallOptions,
  modelID: CatalogModelID,
): import("../bridge/bridge.ts").TurnRequest {
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

function toStreamParts(events: AsyncIterable<TurnEvent>): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      let textId: string | undefined
      let reasoningId: string | undefined
      let usage = emptyUsage()
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
            case "usage":
              usage = usageFrom(event.input, event.output)
              break
            case "done":
              break
            case "failed":
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
        controller.enqueue({
          type: "finish",
          finishReason: stopped(),
          usage,
        })
        controller.close()
      } catch (error) {
        controller.enqueue({ type: "error", error })
        controller.close()
      }
    },
  })
}

export function catalogIdFromModel(id: string): CatalogModelID {
  return asCatalogModelID(id)
}

function emptyUsage(): LanguageModelV3Usage {
  return usageFrom(0, 0)
}

function usageFrom(input: number, output: number): LanguageModelV3Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  }
}

function stopped(): LanguageModelV3FinishReason {
  return { unified: "stop", raw: undefined }
}
