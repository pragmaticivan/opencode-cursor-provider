import { Agent, AgentNotFoundError, AuthenticationError, CursorAgentError } from "@cursor/sdk"
import type { CursorLink } from "../auth/link.ts"
import { asAgentID, nowMs, type CatalogModelID, type CursorApiKey } from "../ids.ts"
import { resolveWireId, type CursorModelDescriptor } from "../catalog/catalog.ts"
import { createBindingStore, route, type BindingStore, type TurnScope } from "./binding.ts"
import { newUserTurns, render, userTurns, type Conversation } from "./conversation.ts"
import { stampSystem } from "./correlation.ts"
import { translate, type TurnEvent } from "./translate.ts"

export interface SessionAgentBridge {
  annotate(system: string[], scope: TurnScope): string[]
  turn(request: TurnRequest): AsyncIterable<TurnEvent>
}

export interface TurnRequest {
  readonly modelID: CatalogModelID
  readonly scope: TurnScope | undefined
  readonly conversation: Conversation
  readonly signal?: AbortSignal
}

function createLock() {
  const locks = new Map<string, Promise<void>>()
  return async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve()
    let release = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    locks.set(
      key,
      previous.then(() => current),
    )
    await previous
    try {
      return await run()
    } finally {
      release()
      if (locks.get(key) === current) locks.delete(key)
    }
  }
}

export function createSessionAgentBridge(input: {
  link: CursorLink
  models: () => readonly CursorModelDescriptor[]
  bindings?: BindingStore
  clock?: () => number
}): SessionAgentBridge {
  const bindings = input.bindings ?? createBindingStore()
  const clock = input.clock ?? Date.now
  const withLock = createLock()

  return {
    annotate(system, scope) {
      return stampSystem(system, scope)
    },
    async *turn(request) {
      const key = request.scope?.sessionID ?? "one-shot"
      yield* await withLock(key, () => collectTurn(input, bindings, clock, request))
    },
  }
}

async function collectTurn(
  input: {
    link: CursorLink
    models: () => readonly CursorModelDescriptor[]
  },
  bindings: BindingStore,
  clock: () => number,
  request: TurnRequest,
): Promise<TurnEvent[]> {
  const events: TurnEvent[] = []
  for await (const event of runTurn(input, bindings, clock, request)) {
    events.push(event)
  }
  return events
}

async function* runTurn(
  input: {
    link: CursorLink
    models: () => readonly CursorModelDescriptor[]
  },
  bindings: BindingStore,
  clock: () => number,
  request: TurnRequest,
): AsyncGenerator<TurnEvent> {
  const apiKey = await input.link.resolve()
  if (apiKey === undefined) {
    yield { type: "failed", error: { kind: "not-linked" } }
    return
  }

  const wireID = resolveWireId(input.models(), request.modelID)
  if (wireID === undefined) {
    yield { type: "failed", error: { kind: "model-unknown", modelID: request.modelID } }
    return
  }

  const binding = request.scope ? bindings.get(request.scope.sessionID) : undefined
  const kind = route({
    scope: request.scope,
    binding,
    modelID: request.modelID,
    userTurns: userTurns(request.conversation),
  })

  const prompt =
    kind === "RESUME" && binding
      ? render([], newUserTurns(request.conversation, binding.forwardedTurns))
      : render(request.conversation.system, request.conversation.turns)

  if (prompt.trim().length === 0) {
    yield { type: "done", reason: "stop" }
    return
  }

  try {
    yield* executeAgent({
      apiKey,
      wireID,
      request,
      kind,
      binding,
      bindings,
      clock,
      prompt,
      retryLost: true,
    })
  } catch (error) {
    if (request.signal?.aborted) {
      yield { type: "failed", error: { kind: "cancelled" } }
      return
    }
    if (error instanceof AuthenticationError) {
      input.link.reject()
      yield { type: "failed", error: { kind: "not-linked" } }
      return
    }
    if (error instanceof CursorAgentError) {
      yield { type: "failed", error: { kind: "agent-start-failed", detail: error.message } }
      return
    }
    yield {
      type: "failed",
      error: { kind: "agent-start-failed", detail: error instanceof Error ? error.message : "unknown error" },
    }
  }
}

async function* executeAgent(input: {
  apiKey: CursorApiKey
  wireID: string
  request: TurnRequest
  kind: ReturnType<typeof route>
  binding: ReturnType<BindingStore["get"]>
  bindings: BindingStore
  clock: () => number
  prompt: string
  retryLost: boolean
}): AsyncGenerator<TurnEvent> {
  const cwd = input.request.scope?.cwd ?? process.cwd()
  const agent =
    input.kind === "RESUME" && input.binding
      ? await Agent.resume(input.binding.agentID, {
          apiKey: input.apiKey,
          model: { id: input.wireID },
          local: { cwd },
        })
      : await Agent.create({
          apiKey: input.apiKey,
          model: { id: input.wireID },
          local: { cwd },
        })

  try {
    const run = await agent.send(input.prompt)
    for await (const message of run.stream()) {
      if (input.request.signal?.aborted) {
        if (run.supports("cancel")) await run.cancel()
        yield { type: "failed", error: { kind: "cancelled" } }
        return
      }
      yield* translate(message)
    }
    const result = await run.wait()
    if (result.status === "error") {
      yield { type: "failed", error: { kind: "agent-run-failed", detail: result.id } }
      return
    }
    if (result.status === "cancelled") {
      yield { type: "failed", error: { kind: "cancelled" } }
      return
    }
    if (input.request.scope && input.kind !== "ONE_SHOT") {
      input.bindings.put({
        sessionID: input.request.scope.sessionID,
        agentID: asAgentID(agent.agentId),
        modelID: input.request.modelID,
        cwd: input.request.scope.cwd,
        forwardedTurns: userTurns(input.request.conversation),
        lastUsedAt: nowMs(input.clock),
      })
    }
    yield { type: "done", reason: "stop" }
  } catch (error) {
    if (input.retryLost && input.kind === "RESUME" && input.request.scope && isAgentLost(error)) {
      input.bindings.drop(input.request.scope.sessionID)
      yield* executeAgent({ ...input, kind: "FRESH", binding: undefined, retryLost: false })
      return
    }
    throw error
  } finally {
    await agent[Symbol.asyncDispose]()
  }
}

function isAgentLost(error: unknown): boolean {
  return error instanceof AgentNotFoundError
}
