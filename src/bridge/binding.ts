import type { CatalogModelID, CursorAgentID, EpochMs, OpencodeSessionID } from "../ids.ts"

export interface SessionAgentBinding {
  readonly sessionID: OpencodeSessionID
  readonly agentID: CursorAgentID
  readonly modelID: CatalogModelID
  readonly cwd: string
  readonly forwardedTurns: number
  readonly lastUsedAt: EpochMs
}

export interface TurnScope {
  readonly sessionID: OpencodeSessionID
  readonly cwd: string
}

export type RouteKind = "ONE_SHOT" | "FRESH" | "RESUME"

export function route(input: {
  readonly scope: TurnScope | undefined
  readonly binding: SessionAgentBinding | undefined
  readonly modelID: CatalogModelID
  readonly userTurns: number
}): RouteKind {
  if (input.scope === undefined) return "ONE_SHOT"
  if (input.binding === undefined) return "FRESH"
  if (input.binding.modelID !== input.modelID) return "FRESH"
  if (input.binding.cwd !== input.scope.cwd) return "FRESH"
  if (input.userTurns <= input.binding.forwardedTurns) return "FRESH"
  return "RESUME"
}

export interface BindingStore {
  get(sessionID: OpencodeSessionID): SessionAgentBinding | undefined
  put(binding: SessionAgentBinding): void
  drop(sessionID: OpencodeSessionID): void
}

export function createBindingStore(): BindingStore {
  const bindings = new Map<OpencodeSessionID, SessionAgentBinding>()
  return {
    get(sessionID) {
      return bindings.get(sessionID)
    },
    put(binding) {
      bindings.set(binding.sessionID, binding)
    },
    drop(sessionID) {
      bindings.delete(sessionID)
    },
  }
}
