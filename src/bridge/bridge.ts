import type { CursorLink } from "../auth/link.ts"
import type { CursorModelDescriptor } from "../catalog/catalog.ts"
import type { OpencodeSessionID } from "../ids.ts"
import { createBindingStore, type BindingStore, type TurnScope } from "./binding.ts"
import { stampSystem } from "./correlation.ts"
import { createLock } from "./lock.ts"
import { createTurnRunner, type TurnRequest } from "./turn.ts"
import type { TurnEvent } from "./translate.ts"

export type { TurnRequest } from "./turn.ts"

export interface SessionAgentBridge {
  annotate(system: string[], scope: TurnScope): string[]
  turn(request: TurnRequest): AsyncIterable<TurnEvent>
  cancel(sessionID: OpencodeSessionID, reason: string): Promise<void>
  dispose(): Promise<void>
}

export function createSessionAgentBridge(input: {
  link: CursorLink
  models: () => readonly CursorModelDescriptor[]
  bindings?: BindingStore
}): SessionAgentBridge {
  const runTurn = createTurnRunner({
    link: input.link,
    models: input.models,
    bindings: input.bindings ?? createBindingStore(),
    lock: createLock(),
  })

  return {
    annotate(system, scope) {
      return stampSystem(system, scope)
    },
    turn(request) {
      return runTurn(request)
    },
    cancel(sessionID, reason) {
      return runTurn.cancel(sessionID, reason)
    },
    dispose() {
      return runTurn.dispose()
    },
  }
}
