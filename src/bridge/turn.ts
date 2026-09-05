import { AuthenticationError, CursorAgentError, type ModelParameterValue, type TokenUsage } from "@cursor/sdk"
import type { CursorLink } from "../auth/link.ts"
import { resolveWireId, type CursorModelDescriptor } from "../catalog/catalog.ts"
import { nowMs, type CatalogModelID, type CursorApiKey } from "../ids.ts"
import { isAgentLost, openCursorAgent } from "./agent.ts"
import { route, type BindingStore, type RouteKind, type SessionAgentBinding, type TurnScope } from "./binding.ts"
import { newUserTurns, render, userTurns, type Conversation } from "./conversation.ts"
import type { KeyedLock } from "./lock.ts"
import { translate, type TurnEvent } from "./translate.ts"

export interface TurnRequest {
  readonly modelID: CatalogModelID
  readonly scope: TurnScope | undefined
  readonly conversation: Conversation
  readonly params?: readonly ModelParameterValue[]
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
  readonly prompt: string
}

export function createTurnRunner(ctx: TurnRunnerContext): (request: TurnRequest) => AsyncIterable<TurnEvent> {
  return (request) => runTurn(ctx, request)
}

async function* runTurn(ctx: TurnRunnerContext, request: TurnRequest): AsyncGenerator<TurnEvent> {
  const lockKey = request.scope?.sessionID ?? "one-shot"
  const release = await ctx.lock.acquire(lockKey)

  try {
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
    if (plan.prompt.trim().length === 0) {
      yield { type: "done", reason: "stop" }
      return
    }

    let retryLost = true
    while (true) {
      let session: Awaited<ReturnType<typeof openCursorAgent>> | undefined
      try {
        session = await (ctx.openAgent ?? openCursorAgent)({
          apiKey: plan.apiKey,
          wireID: plan.wireID,
          params: plan.params,
          cwd: request.scope?.cwd ?? process.cwd(),
          resume: plan.kind === "RESUME" ? plan.binding?.agentID : undefined,
        })
        const run = await session.send(plan.prompt)
        let cancelPromise: Promise<void> | undefined
        const cancel = () => {
          if (cancelPromise !== undefined || !run.supports("cancel")) return
          cancelPromise = run.cancel().catch(() => {})
        }
        request.signal?.addEventListener("abort", cancel)
        if (request.signal?.aborted) cancel()

        let sawUsage = false
        try {
          for await (const message of run.stream()) {
            if (request.signal?.aborted) {
              yield { type: "failed", error: { kind: "cancelled" } }
              return
            }
            for (const event of translate(message)) {
              if (event.type === "usage") sawUsage = true
              yield event
            }
          }

          if (request.signal?.aborted) {
            yield { type: "failed", error: { kind: "cancelled" } }
            return
          }

          const result = await run.wait()
          if (result.status === "cancelled") {
            yield { type: "failed", error: { kind: "cancelled" } }
            return
          }
          if (!sawUsage && result.usage !== undefined) yield usageEvent(result.usage)
          if (result.status === "error") {
            yield {
              type: "failed",
              error: { kind: "agent-run-failed", detail: result.error?.message ?? result.id },
            }
            return
          }

          yield { type: "done", reason: "stop" }
          if (request.scope && plan.kind !== "ONE_SHOT") {
            ctx.bindings.put({
              sessionID: request.scope.sessionID,
              agentID: session.id,
              modelID: request.modelID,
              cwd: request.scope.cwd,
              forwardedTurns: userTurns(request.conversation),
              lastUsedAt: nowMs(ctx.clock),
            })
          }
          return
        } finally {
          request.signal?.removeEventListener("abort", cancel)
          await cancelPromise
        }
      } catch (error) {
        if (retryLost && plan.kind === "RESUME" && request.scope && isAgentLost(error)) {
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
    userTurns: userTurns(request.conversation),
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
  }
}

function promptFor(kind: RouteKind, conversation: Conversation, binding: SessionAgentBinding | undefined): string {
  if (kind === "RESUME" && binding) {
    return render([], newUserTurns(conversation, binding.forwardedTurns))
  }
  return render(conversation.system, conversation.turns)
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
