import { Integration, Model, Provider } from "@opencode-ai/plugin"
import type { CatalogEditor } from "@opencode-ai/plugin/promise/catalog"
import { PACKAGE_SPEC, PROVIDER_ID, asCatalogModelID, asCursorModelID, type CatalogModelID, type CursorModelID } from "../ids.ts"

export interface CursorModelDescriptor {
  readonly catalogID: CatalogModelID
  readonly wireID: CursorModelID
  readonly name: string
}

export const SEED_MODELS: readonly CursorModelDescriptor[] = [
  {
    catalogID: asCatalogModelID("composer-2.5"),
    wireID: asCursorModelID("composer-2.5"),
    name: "Composer 2.5",
  },
  {
    catalogID: asCatalogModelID("auto"),
    wireID: asCursorModelID("auto"),
    name: "Cursor Auto",
  },
]

export function providerId() {
  return Provider.ID.make(PROVIDER_ID)
}

export function applyProvider(draft: CatalogEditor): void {
  draft.provider.update(PROVIDER_ID, (provider) => {
    provider.id = providerId()
    provider.name = "Cursor"
    provider.package = PACKAGE_SPEC
    provider.integrationID = Integration.ID.make(PROVIDER_ID)
    provider.activation = "auto"
    dropBaseURL(provider.settings)
  })
}

export function applyModels(draft: CatalogEditor, models: readonly CursorModelDescriptor[]): void {
  for (const model of models) {
    draft.model.update(PROVIDER_ID, model.catalogID, (entry) => {
      const defaults = Model.Info.default(providerId(), Model.ID.make(model.catalogID))
      entry.id = defaults.id
      entry.modelID = Model.ID.make(model.wireID)
      entry.providerID = defaults.providerID
      entry.name = model.name
      entry.capabilities = { tools: false, input: ["text"], output: ["text"] }
      entry.variants = defaults.variants
      entry.time = defaults.time
      entry.cost = defaults.cost
      entry.status = "active"
      entry.enabled = true
      entry.limit = defaults.limit
      entry.package = PACKAGE_SPEC
      dropBaseURL(entry.settings)
    })
  }
  const preferred = models[0]
  if (preferred) {
    draft.model.update(PROVIDER_ID, "default", (entry) => {
      const defaults = Model.Info.default(providerId(), Model.ID.make("default"))
      entry.id = defaults.id
      entry.modelID = Model.ID.make(preferred.wireID)
      entry.providerID = defaults.providerID
      entry.name = preferred.name
      entry.capabilities = { tools: false, input: ["text"], output: ["text"] }
      entry.variants = defaults.variants
      entry.time = defaults.time
      entry.cost = defaults.cost
      entry.status = "active"
      entry.enabled = true
      entry.limit = defaults.limit
      entry.package = PACKAGE_SPEC
      dropBaseURL(entry.settings)
    })
    draft.model.default.set(PROVIDER_ID, preferred.catalogID)
  }
}

export function parseListedModels(raw: unknown): CursorModelDescriptor[] {
  const listed: CursorModelDescriptor[] = []
  const seen = new Set<string>()
  for (const item of listedItems(raw)) {
    const parsed = parseListedItem(item)
    if (parsed === undefined) continue
    if (seen.has(parsed.catalogID)) continue
    seen.add(parsed.catalogID)
    listed.push(parsed)
  }
  if (listed.length === 0) return [...SEED_MODELS]
  for (const seed of SEED_MODELS) {
    if (!seen.has(seed.catalogID)) listed.push(seed)
  }
  return listed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function listedItems(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw
  if (isRecord(raw) && Array.isArray(raw.items)) return raw.items
  return []
}

function parseListedItem(item: unknown): CursorModelDescriptor | undefined {
  if (!isRecord(item)) return undefined
  const nested = isRecord(item.model) ? item.model : undefined
  const rawId = typeof item.id === "string" ? item.id : typeof nested?.id === "string" ? nested.id : undefined
  if (rawId === undefined) return undefined
  const id = rawId.trim()
  if (id.length === 0) return undefined
  const rawName = typeof item.displayName === "string" ? item.displayName : undefined
  const name = rawName && rawName.length > 0 ? rawName : id
  return {
    catalogID: asCatalogModelID(id),
    wireID: asCursorModelID(id),
    name,
  }
}

function dropBaseURL(settings: Record<string, unknown> | undefined): void {
  if (settings === undefined) return
  delete settings.baseURL
}

export function resolveWireId(
  models: readonly CursorModelDescriptor[],
  catalogID: string,
): CursorModelID | undefined {
  const match = models.find((model) => model.catalogID === catalogID)
  return match?.wireID
}
