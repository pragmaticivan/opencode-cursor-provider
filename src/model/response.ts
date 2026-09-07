import type {
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3ResponseMetadata,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import type { TurnEvent } from "../bridge/translate.ts"
import { CursorPluginFailure } from "../errors.ts"

export async function collectGenerate(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3GenerateResult> {
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

export function toStreamParts(
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
            case "tool-request":
              if (tools.has(event.id)) break
              closeOpenParts()
              controller.enqueue({
                type: "tool-call",
                toolCallId: event.id,
                toolName: event.name,
                input: JSON.stringify(event.input),
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

export function coupleAbort(signal: AbortSignal | undefined): { signal: AbortSignal; abort: AbortController } {
  const abort = new AbortController()
  if (signal === undefined) return { signal: abort.signal, abort }
  if (signal.aborted) {
    abort.abort()
    return { signal, abort }
  }
  return { signal: AbortSignal.any([signal, abort.signal]), abort }
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
  if (reason === "tool-calls") return { unified: "tool-calls", raw: reason }
  return { unified: "other", raw: reason }
}
