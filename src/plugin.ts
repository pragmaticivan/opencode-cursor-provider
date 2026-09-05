import { Plugin } from "@opencode-ai/plugin"
import { createCursorLink, type CursorLink } from "./auth/link.ts"
import { createSessionAgentBridge } from "./bridge/bridge.ts"
import { sessionFromId } from "./bridge/correlation.ts"
import { applyModels, applyProvider, modelParamsFromOptions } from "./catalog/catalog.ts"
import { createModelSource, type ModelSource } from "./catalog/source.ts"
import { asCatalogModelID, PROVIDER_ID } from "./ids.ts"
import { toLanguageModel } from "./model/language-model.ts"
import { bindRuntime } from "./runtime.ts"

const REFRESH_EVERY_MS = 5_000
const REFRESH_FOR_MS = 300_000

export const plugin = Plugin.define({
  id: "opencode-cursor-provider",
  async setup(ctx) {
    const link = createCursorLink()
    const models = createModelSource(link)
    const bridge = createSessionAgentBridge({
      link,
      models: () => models.list(),
    })
    bindRuntime({
      bridge,
      models: () => models.list(),
    })

    const languageModel = (model: { id: string; modelID: string }, fallbackID: string, options: unknown) =>
      toLanguageModel({
        bridge,
        modelID: asCatalogModelID(model.id),
        wireID: model.modelID || fallbackID,
        ...paramsOption(options),
      })

    const registrations = [
      await ctx.integration.transform((draft) => {
        link.register(draft)
      }),
      await ctx.catalog.transform((draft) => {
        applyProvider(draft)
        applyModels(draft, models.list())
      }),
      await ctx.session.hook(
        "context",
        async (event) => {
          event.tools = {}
          if (String(event.agent) === "compaction" || String(event.agent) === "title") return
          const stamped = bridge.annotate(
            event.system.map((part) => part.text),
            sessionFromId(event.sessionID, await sessionCwd(ctx, event.sessionID)),
          )
          writeSystem(event.system, stamped)
        },
        { providerID: PROVIDER_ID },
      ),
      await ctx.aisdk.hook(
        "sdk",
        (event) => {
          if (event.sdk) return
          event.sdk = {
            languageModel: (modelID: string) => languageModel(event.model, modelID, event.options),
          }
        },
        { providerID: PROVIDER_ID },
      ),
      await ctx.aisdk.hook(
        "language",
        (event) => {
          event.language = languageModel(event.model, event.model.id, event.options)
        },
        { providerID: PROVIDER_ID },
      ),
    ]

    const stopRefresh = watchModels(ctx, link, models)

    return async () => {
      stopRefresh()
      for (const registration of registrations.toReversed()) {
        await registration.dispose()
      }
    }
  },
})

function paramsOption(options: unknown): { readonly params: NonNullable<ReturnType<typeof modelParamsFromOptions>> } | Record<never, never> {
  const params = modelParamsFromOptions(options)
  if (params === undefined) return {}
  return { params }
}

async function sessionCwd(ctx: Plugin.Context, sessionID: string): Promise<string> {
  try {
    const info = await ctx.session.get({ sessionID })
    if (info.location.directory.length > 0) return info.location.directory
  } catch {
    // Session lookup is best-effort. Plugin location is the fallback cwd.
  }
  return ctx.location.directory
}

function writeSystem(system: Array<{ type: "text"; text: string }>, stamped: string[]): void {
  for (let index = 0; index < stamped.length; index += 1) {
    const text = stamped[index]
    if (text === undefined) continue
    const existing = system[index]
    if (existing === undefined) {
      system.push({ type: "text", text })
      continue
    }
    if (existing.text !== text) system[index] = { type: "text", text }
  }
}

function watchModels(ctx: Plugin.Context, link: CursorLink, models: ModelSource): () => void {
  const events = new AbortController()
  const refresh = () => {
    void models.refresh(ctx)
  }

  const stopLinked = link.onLinked(refresh)
  refresh()

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        if (event.type === "credential.updated" || event.type === "credential.switched") refresh()
      }
    } catch {
      // Subscription ends when the plugin unloads.
    }
  })()

  const retry = setInterval(refresh, REFRESH_EVERY_MS)
  retry.unref?.()
  const stop = setTimeout(() => {
    clearInterval(retry)
  }, REFRESH_FOR_MS)
  stop.unref?.()

  return () => {
    stopLinked()
    events.abort()
    clearInterval(retry)
    clearTimeout(stop)
  }
}
