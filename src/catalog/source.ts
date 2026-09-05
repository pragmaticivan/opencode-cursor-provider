import { AuthenticationError, Cursor } from "@cursor/sdk"
import type { CursorApiKey } from "../ids.ts"
import { parseListedModels, SEED_MODELS, type CursorModelDescriptor } from "./catalog.ts"

type ModelSnapshot =
  | { readonly kind: "seed"; readonly models: readonly CursorModelDescriptor[] }
  | { readonly kind: "listed"; readonly models: readonly CursorModelDescriptor[] }

export interface ModelSourceDependencies {
  restoreCredential(): Promise<void>
  resolveApiKey(): Promise<CursorApiKey | undefined>
  rejectCredential(): void
  reloadCatalog(): Promise<void>
  listModels?(apiKey: CursorApiKey): Promise<unknown>
}

export interface ModelSource {
  list(): readonly CursorModelDescriptor[]
  refresh(): Promise<void>
  close(): Promise<void>
}

export function createModelSource(dependencies: ModelSourceDependencies): ModelSource {
  const listModels = dependencies.listModels ?? ((apiKey: CursorApiKey) => Cursor.models.list({ apiKey }))
  let snapshot: ModelSnapshot = { kind: "seed", models: SEED_MODELS }
  let catalogDirty = false
  let activeDrain: Promise<void> | undefined
  let trailingRefresh = false
  let closed = false
  let closing: Promise<void> | undefined

  async function reloadDirtyCatalog(): Promise<void> {
    if (!catalogDirty) return
    try {
      await dependencies.reloadCatalog()
      catalogDirty = false
    } catch {
      return
    }
  }

  function selectSeeds(): void {
    if (snapshot.kind === "seed") return
    snapshot = { kind: "seed", models: SEED_MODELS }
    catalogDirty = true
  }

  async function refreshOnce(): Promise<void> {
    await dependencies.restoreCredential()
    const apiKey = await dependencies.resolveApiKey()
    if (apiKey === undefined) {
      selectSeeds()
      await reloadDirtyCatalog()
      return
    }

    try {
      snapshot = { kind: "listed", models: parseListedModels(await listModels(apiKey)) }
      catalogDirty = true
    } catch (error) {
      if (error instanceof AuthenticationError) {
        dependencies.rejectCredential()
        selectSeeds()
      }
    }
    await reloadDirtyCatalog()
  }

  function startDrain(): Promise<void> {
    return (async () => {
      try {
        do {
          trailingRefresh = false
          await refreshOnce()
        } while (trailingRefresh)
      } finally {
        activeDrain = undefined
      }
    })()
  }

  return {
    list() {
      return snapshot.models
    },
    refresh() {
      if (closed) return Promise.resolve()
      if (activeDrain !== undefined) {
        trailingRefresh = true
        return activeDrain
      }
      activeDrain = startDrain()
      return activeDrain
    },
    close() {
      if (closing !== undefined) return closing
      closed = true
      closing = activeDrain ?? Promise.resolve()
      return closing
    },
  }
}
