import type { SessionAgentBridge } from "./bridge/bridge.ts"
import { modelParamsFromOptions, resolveWireId, type CursorModelDescriptor } from "./catalog/catalog.ts"
import { asCatalogModelID, asCursorModelID } from "./ids.ts"
import { toLanguageModel } from "./model/language-model.ts"

export interface CursorRuntime {
  readonly bridge: SessionAgentBridge
  readonly models: () => readonly CursorModelDescriptor[]
}

let runtime: CursorRuntime | undefined

export function bindRuntime(next: CursorRuntime): void {
  runtime = next
}

export function model(modelID: string, settings?: unknown) {
  if (runtime === undefined) {
    throw new Error("Cursor is not loaded. Add opencode-cursor-provider to plugins and restart OpenCode.")
  }
  const wireID = resolveWireId(runtime.models(), modelID) ?? asCursorModelID(modelID)
  return toLanguageModel({
    bridge: runtime.bridge,
    modelID: asCatalogModelID(modelID),
    wireID,
    params: modelParamsFromOptions(settings),
  })
}
