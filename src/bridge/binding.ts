import type { AgentModeOption, ModelParameterValue } from "@cursor/sdk"
import type { CatalogModelID, CursorAgentID, OpencodeSessionID } from "../ids.ts"
import type { CursorAgentOptions } from "../model/provider-options.ts"
import { extendsCheckpoint, type Conversation, type ConversationCheckpoint } from "./conversation.ts"

export interface SessionAgentBinding {
  readonly sessionID: OpencodeSessionID
  readonly agentID: CursorAgentID
  readonly modelID: CatalogModelID
  readonly cwd: string
  readonly checkpoint: ConversationCheckpoint
  readonly params: readonly ModelParameterValue[] | undefined
  readonly mode: AgentModeOption | undefined
  readonly agentOptions: CursorAgentOptions | undefined
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
  readonly conversation: Conversation
  readonly params: readonly ModelParameterValue[] | undefined
  readonly mode: AgentModeOption | undefined
  readonly agentOptions: CursorAgentOptions | undefined
}): RouteKind {
  if (input.scope === undefined) return "ONE_SHOT"
  if (input.binding === undefined) return "FRESH"
  if (input.binding.modelID !== input.modelID) return "FRESH"
  if (input.binding.cwd !== input.scope.cwd) return "FRESH"
  if (!sameParams(input.binding.params, input.params)) return "FRESH"
  if (input.binding.mode !== input.mode) return "FRESH"
  if (!sameAgentOptions(input.binding.agentOptions, input.agentOptions)) return "FRESH"
  if (!extendsCheckpoint(input.conversation, input.binding.checkpoint)) return "FRESH"
  return "RESUME"
}

function sameAgentOptions(left: CursorAgentOptions | undefined, right: CursorAgentOptions | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    sameSet(left.tools, right.tools) &&
    sameSet(left.disallowedTools, right.disallowedTools) &&
    left.sandboxOptions?.enabled === right.sandboxOptions?.enabled &&
    left.autoReview === right.autoReview &&
    sameSet(left.settingSources, right.settingSources)
  )
}

function sameSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value))
}

function sameParams(
  left: readonly ModelParameterValue[] | undefined,
  right: readonly ModelParameterValue[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.length !== right.length) return false
  const leftValues = left.map((param) => JSON.stringify([param.id, param.value])).sort()
  const rightValues = right.map((param) => JSON.stringify([param.id, param.value])).sort()
  return leftValues.every((value, index) => value === rightValues[index])
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
