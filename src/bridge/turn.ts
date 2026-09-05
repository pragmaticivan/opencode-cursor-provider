import {
  AuthenticationError,
  CursorAgentError,
  type AgentModeOption,
  type ModelParameterValue,
  type Run,
  type SDKMessage,
  type SDKUserMessage,
  type SendOptions,
  type TokenUsage,
} from "@cursor/sdk"
import type { CursorLink } from "../auth/link.ts"
import { resolveWireId, type CursorModelDescriptor } from "../catalog/catalog.ts"
import { nowMs, type CatalogModelID, type CursorApiKey, type OpencodeSessionID } from "../ids.ts"
import type { CursorAgentOptions } from "../model/provider-options.ts"
import { isAgentLost, openCursorAgent } from "./agent.ts"
import { route, type BindingStore, type RouteKind, type SessionAgentBinding, type TurnScope } from "./binding.ts"
import {
  canonicalJson,
  checkpointOf,
  cursorMessage,
  resumeTurn,
  toolResultsAfter,
  type AssistantPart,
  type Conversation,
} from "./conversation.ts"
import type { KeyedLock } from "./lock.ts"
import { createResponseJournal } from "./response-journal.ts"
import {
  createOpenCodeToolBridge,
  type OpenCodeToolBridge,
  type OpenCodeToolDefinition,
} from "./tool-bridge.ts"
import { createMessageTranslator, type TurnEvent } from "./translate.ts"

export interface TurnRequest {
  readonly modelID: CatalogModelID
  readonly scope: TurnScope | undefined
  readonly conversation: Conversation
  readonly tools?: readonly OpenCodeToolDefinition[]
  readonly params?: readonly ModelParameterValue[]
  readonly mode?: AgentModeOption
  readonly agentOptions?: CursorAgentOptions
  readonly includeRawChunks?: boolean
  readonly signal?: AbortSignal
}

export interface TurnRunnerContext {
  readonly link: CursorLink
  readonly models: () => readonly CursorModelDescriptor[]
  readonly bindings: BindingStore
  readonly clock: () => number
  readonly lock: KeyedLock
  readonly openAgent?: typeof openCursorAgent
}

interface TurnPlan {
  readonly apiKey: CursorApiKey
  readonly wireID: string
  readonly params: readonly ModelParameterValue[] | undefined
  readonly kind: RouteKind
  readonly binding: SessionAgentBinding | undefined
  readonly prompt: string | SDKUserMessage
}

export function createTurnRunner(ctx: TurnRunnerContext) {
  const liveRuns = new Map<OpencodeSessionID, LiveCursorRun>()
  return Object.assign(
    (request: TurnRequest) => runTurn(ctx, request, liveRuns),
    {
      async cancel(sessionID: OpencodeSessionID, reason: string) {
        const release = await ctx.lock.acquire(sessionID)
        try {
          const live = liveRuns.get(sessionID)
          if (live === undefined) return
          liveRuns.delete(sessionID)
          await closeLiveRun(live, reason)
        } finally {
          release()
        }
      },
      async dispose() {
        await Promise.all([...liveRuns.values()].map((live) => closeLiveRun(live, "Cursor provider stopped")))
        liveRuns.clear()
      },
    },
  )
}

export type TurnRunner = ReturnType<typeof createTurnRunner>

interface LiveCursorRun {
  readonly identity: string
  readonly session: Awaited<ReturnType<typeof openCursorAgent>>
  readonly run: Run
  readonly messages: AsyncIterator<SDKMessage>
  readonly toolBridge: OpenCodeToolBridge | undefined
  readonly translate: ReturnType<typeof createMessageTranslator>
  readonly plan: TurnPlan
  nextMessage: Promise<IteratorResult<SDKMessage>> | undefined
  continuation: {
    readonly checkpoint: ReturnType<typeof checkpointOf>
    readonly calls: readonly { readonly id: string; readonly name: string }[]
  } | undefined
  sawUsage: boolean
}

async function* runTurn(
  ctx: TurnRunnerContext,
  request: TurnRequest,
  liveRuns: Map<OpencodeSessionID, LiveCursorRun>,
): AsyncGenerator<TurnEvent> {
  const lockKey = request.scope?.sessionID ?? "one-shot"
  const release = await ctx.lock.acquire(lockKey)

  try {
    const scope = request.scope
    if (scope === undefined && (request.tools?.length ?? 0) > 0) {
      yield { type: "failed", error: { kind: "unsupported-request", reason: "tools-requested" } }
      return
    }
    const suspended = scope === undefined ? undefined : liveRuns.get(scope.sessionID)
    if (scope !== undefined && suspended !== undefined) {
      if (suspended.identity !== liveIdentity(request)) {
        await closeLiveRun(suspended, "The OpenCode request changed while a tool call was pending")
        liveRuns.delete(scope.sessionID)
        ctx.bindings.drop(scope.sessionID)
      } else {
        const continuation = suspended.continuation
        const parts = continuation === undefined
          ? undefined
          : toolResultsAfter(request.conversation, continuation.checkpoint, continuation.calls)
        const resolved = parts === undefined
          ? 0
          : suspended.toolBridge?.resolve(parts.map((part) => ({ id: part.id, output: part.output, isError: part.isError }))) ?? 0
        if (resolved !== continuation?.calls.length) {
          await closeLiveRun(suspended, "OpenCode did not return the pending tool result")
          liveRuns.delete(scope.sessionID)
          ctx.bindings.drop(scope.sessionID)
        } else {
          let outcome: "finished" | "suspended"
          try {
            outcome = yield* drainLiveRun(ctx, request, suspended)
          } catch (error) {
            liveRuns.delete(scope.sessionID)
            ctx.bindings.drop(scope.sessionID)
            await closeLiveRun(suspended, "The Cursor run failed")
            yield failedFromCaught(error, request.signal, ctx.link.reject)
            return
          }
          if (outcome === "suspended") return
          liveRuns.delete(scope.sessionID)
          await suspended.session.dispose()
          return
        }
      }
    }

    const apiKey = await ctx.link.resolve()
    if (apiKey === undefined) {
      yield { type: "failed", error: { kind: "not-linked" } }
      return
    }

    const wireID = resolveWireId(ctx.models(), request.modelID)
    if (wireID === undefined) {
      yield { type: "failed", error: { kind: "model-unknown", modelID: request.modelID } }
      return
    }

    let plan = planTurn(request, apiKey, wireID, ctx.bindings)
    if (typeof plan.prompt === "string" && plan.prompt.trim().length === 0) {
      yield { type: "done", reason: "stop" }
      return
    }

    let retryLost = true
    while (true) {
      let session: Awaited<ReturnType<typeof openCursorAgent>> | undefined
      let emitted = false
      try {
        if (request.signal?.aborted) {
          yield { type: "failed", error: { kind: "cancelled" } }
          return
        }
        session = await (ctx.openAgent ?? openCursorAgent)({
          apiKey: plan.apiKey,
          wireID: plan.wireID,
          params: plan.params,
          cwd: request.scope?.cwd ?? process.cwd(),
          resume: plan.kind === "RESUME" ? plan.binding?.agentID : undefined,
          agentOptions: request.agentOptions,
        })
        if (request.signal?.aborted) {
          yield { type: "failed", error: { kind: "cancelled" } }
          return
        }
        const toolBridge = request.scope === undefined ? undefined : createOpenCodeToolBridge(request.tools ?? [])
        const customTools = toolBridge === undefined ? {} : toolBridge.customTools
        const sendOptions: SendOptions = {
          ...(request.mode === undefined ? {} : { mode: request.mode }),
          ...(Object.keys(customTools).length === 0 ? {} : { local: { customTools } }),
        }
        const run = await session.send(plan.prompt, Object.keys(sendOptions).length === 0 ? undefined : sendOptions)
        emitted = true
        yield {
          type: "response-metadata",
          id: run.id,
          ...(run.createdAt === undefined ? {} : { timestamp: run.createdAt }),
          modelId: run.model?.id ?? plan.wireID,
        }
        const live: LiveCursorRun = {
          identity: liveIdentity(request),
          session,
          run,
          messages: run.stream()[Symbol.asyncIterator](),
          toolBridge,
          translate: createMessageTranslator(),
          plan,
          nextMessage: undefined,
          continuation: undefined,
          sawUsage: false,
        }
        const outcome = yield* drainLiveRun(ctx, request, live)
        if (outcome === "suspended" && request.scope !== undefined) {
          liveRuns.set(request.scope.sessionID, live)
          session = undefined
        }
        return
      } catch (error) {
        if (retryLost && !emitted && plan.kind === "RESUME" && request.scope && isAgentLost(error)) {
          retryLost = false
          ctx.bindings.drop(request.scope.sessionID)
          plan = {
            ...plan,
            kind: "FRESH",
            binding: undefined,
            prompt: promptFor("FRESH", request.conversation, undefined),
          }
          continue
        }
        yield failedFromCaught(error, request.signal, ctx.link.reject)
        return
      } finally {
        await session?.dispose()
      }
    }
  } finally {
    release()
  }
}

function liveIdentity(request: TurnRequest): string {
  return canonicalJson({
    modelID: request.modelID,
    cwd: request.scope?.cwd,
    params: request.params,
    mode: request.mode,
    agentOptions: request.agentOptions,
    tools: request.tools,
  })
}

async function* drainLiveRun(
  ctx: TurnRunnerContext,
  request: TurnRequest,
  live: LiveCursorRun,
): AsyncGenerator<TurnEvent, "finished" | "suspended"> {
  let cancelPromise: Promise<void> | undefined
  const cancel = () => {
    live.toolBridge?.cancel("The OpenCode request was cancelled")
    if (cancelPromise !== undefined || !live.run.supports("cancel")) return
    cancelPromise = live.run.cancel().catch(() => {})
  }
  request.signal?.addEventListener("abort", cancel)
  if (request.signal?.aborted) cancel()
  const response = createResponseJournal()

  try {
    while (true) {
      if (request.signal?.aborted) {
        yield { type: "failed", error: { kind: "cancelled" } }
        return "finished"
      }
      const nextMessage = live.nextMessage ?? live.messages.next()
      live.nextMessage = nextMessage
      const next = live.toolBridge === undefined
        ? { type: "message" as const, value: await nextMessage }
        : await Promise.race([
            nextMessage.then((value) => ({ type: "message" as const, value })),
            live.toolBridge.waitForCalls().then(() => ({ type: "tools" as const })),
          ])
      if (next.type === "tools") {
        const calls = live.toolBridge?.takeCalls() ?? []
        if (calls.length === 0) continue
        for (const call of calls) {
          const event = { type: "tool-request" as const, ...call }
          response.accept(event)
          yield event
        }
        live.continuation = {
          checkpoint: checkpointOf(withResponse(request.conversation, response.parts())),
          calls: calls.map((call) => ({ id: call.id, name: call.name })),
        }
        yield { type: "done", reason: "tool-calls" }
        return "suspended"
      }
      live.nextMessage = undefined
      if (next.value.done) break
      const message = next.value.value
      if (request.includeRawChunks === true) yield { type: "raw", value: message }
      for (const candidate of live.translate(message)) {
        if (
          (candidate.type === "tool-call" || candidate.type === "tool-result") &&
          live.toolBridge?.isCursorCall(candidate.id)
        ) {
          continue
        }
        const event = response.accept(candidate)
        if (event === undefined) continue
        if (event.type === "usage") live.sawUsage = true
        yield event
      }
    }

    const result = await live.run.wait()
    if (result.status === "cancelled") {
      yield { type: "failed", error: { kind: "cancelled" } }
      return "finished"
    }
    if (!live.sawUsage && result.usage !== undefined) yield usageEvent(result.usage)
    if (result.status === "error") {
      yield { type: "failed", error: { kind: "agent-run-failed", detail: result.error?.message ?? result.id } }
      return "finished"
    }
    if (request.scope && live.plan.kind !== "ONE_SHOT") {
      ctx.bindings.put({
        sessionID: request.scope.sessionID,
        agentID: live.session.id,
        modelID: request.modelID,
        cwd: request.scope.cwd,
        checkpoint: checkpointOf(withResponse(request.conversation, response.parts())),
        params: request.params,
        mode: request.mode,
        agentOptions: request.agentOptions,
        lastUsedAt: nowMs(ctx.clock),
      })
    }
    yield {
      type: "done",
      reason: "stop",
      metadata: {
        runId: result.id,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
        ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
        ...(result.model === undefined ? {} : { modelId: result.model.id }),
      },
    }
    return "finished"
  } finally {
    request.signal?.removeEventListener("abort", cancel)
    await cancelPromise
  }
}

async function closeLiveRun(live: LiveCursorRun, reason: string): Promise<void> {
  live.toolBridge?.cancel(reason)
  if (live.run.supports("cancel")) await live.run.cancel().catch(() => {})
  await live.nextMessage?.catch(() => {})
  await live.session.dispose()
}

function withResponse(
  conversation: Conversation,
  parts: readonly AssistantPart[],
): Conversation {
  if (parts.length === 0) return conversation
  return { ...conversation, turns: [...conversation.turns, { role: "assistant", parts }] }
}

function planTurn(
  request: TurnRequest,
  apiKey: CursorApiKey,
  wireID: string,
  bindings: BindingStore,
): TurnPlan {
  const binding = request.scope ? bindings.get(request.scope.sessionID) : undefined
  const kind = route({
    scope: request.scope,
    binding,
    modelID: request.modelID,
    conversation: request.conversation,
    params: request.params,
    mode: request.mode,
    agentOptions: request.agentOptions,
  })
  return {
    apiKey,
    wireID,
    params: request.params,
    kind,
    binding,
    prompt: promptFor(kind, request.conversation, binding),
  }
}

function usageEvent(usage: TokenUsage): Extract<TurnEvent, { type: "usage" }> {
  return {
    type: "usage",
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    reasoning: usage.reasoningTokens ?? 0,
    total: usage.totalTokens,
  }
}

function promptFor(
  kind: RouteKind,
  conversation: Conversation,
  binding: SessionAgentBinding | undefined,
): string | SDKUserMessage {
  if (kind === "RESUME" && binding) {
    const turn = resumeTurn(conversation, binding.checkpoint)
    if (turn !== undefined) return cursorMessage([], [turn])
  }
  return cursorMessage(conversation.system, conversation.turns)
}

function failedFromCaught(error: unknown, signal: AbortSignal | undefined, unlink: () => void): TurnEvent {
  if (signal?.aborted) return { type: "failed", error: { kind: "cancelled" } }
  if (error instanceof AuthenticationError) {
    unlink()
    return { type: "failed", error: { kind: "not-linked" } }
  }
  if (error instanceof CursorAgentError) {
    return { type: "failed", error: { kind: "agent-start-failed", detail: error.message } }
  }
  return {
    type: "failed",
    error: { kind: "agent-start-failed", detail: error instanceof Error ? error.message : "unknown error" },
  }
}
