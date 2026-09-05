import { AuthenticationError, Cursor } from "@cursor/sdk"
import { Plugin } from "@opencode-ai/plugin"
import { createCursorLink } from "./auth/link.ts"
import { createSessionAgentBridge } from "./bridge/bridge.ts"
import { sessionFromId } from "./bridge/correlation.ts"
import { applyModels, applyProvider, parseListedModels, SEED_MODELS, type CursorModelDescriptor } from "./catalog/catalog.ts"
import { PROVIDER_ID } from "./ids.ts"
import { catalogIdFromModel, toLanguageModel } from "./model/language-model.ts"
import { bindRuntime } from "./runtime.ts"

export const plugin = Plugin.define({
  id: "opencode-cursor-provider",
  async setup(ctx) {
    const link = createCursorLink()
    let models: CursorModelDescriptor[] = [...SEED_MODELS]
    const bridge = createSessionAgentBridge({
      link,
      models: () => models,
    })
    bindRuntime({
      bridge,
      models: () => models,
    })

    const registrations = [
      await ctx.integration.transform((draft) => {
        link.register(draft)
      }),
      await ctx.catalog.transform((draft) => {
        applyProvider(draft)
        applyModels(draft, models)
      }),
      await ctx.session.hook(
        "context",
        async (event) => {
          event.tools = {}
          if (String(event.agent) === "compaction" || String(event.agent) === "title") return
          let cwd: string = ctx.location.directory
          try {
            const info = await ctx.session.get({ sessionID: event.sessionID })
            if (info.location.directory.length > 0) cwd = info.location.directory
          } catch {
            // Session lookup is best-effort. Plugin location is the fallback cwd.
          }
          const stamped = bridge.annotate(
            event.system.map((part) => part.text),
            sessionFromId(event.sessionID, cwd),
          )
          for (let index = 0; index < stamped.length; index += 1) {
            const text = stamped[index]
            if (text === undefined) continue
            const existing = event.system[index]
            if (existing === undefined) {
              event.system.push({ type: "text", text })
              continue
            }
            if (existing.text !== text) event.system[index] = { type: "text", text }
          }
        },
        { providerID: PROVIDER_ID },
      ),
      await ctx.aisdk.hook(
        "sdk",
        (event) => {
          if (event.sdk) return
          event.sdk = {
            languageModel: (modelID: string) =>
              toLanguageModel({
                bridge,
                modelID: catalogIdFromModel(event.model.id),
                wireID: event.model.modelID || modelID,
              }),
          }
        },
        { providerID: PROVIDER_ID },
      ),
      await ctx.aisdk.hook(
        "language",
        (event) => {
          event.language = toLanguageModel({
            bridge,
            modelID: catalogIdFromModel(event.model.id),
            wireID: event.model.modelID || event.model.id,
          })
        },
        { providerID: PROVIDER_ID },
      ),
    ]

    async function refreshModels(): Promise<void> {
      await link.restore(ctx)
      const apiKey = await link.resolve()
      if (apiKey === undefined) return
      try {
        models = parseListedModels(await Cursor.models.list({ apiKey }))
      } catch (error) {
        if (error instanceof AuthenticationError) link.reject()
        return
      }
      try {
        await ctx.catalog.reload()
      } catch {
        // Keep the listed models. The next credential or poll can replay the catalog.
      }
    }

    link.onLinked(() => {
      void refreshModels()
    })
    void refreshModels()

    const events = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type === "credential.updated" || event.type === "credential.switched") {
            void refreshModels()
          }
        }
      } catch {
        // Subscription ends when the plugin unloads.
      }
    })()

    const retry = setInterval(() => {
      void refreshModels()
    }, 5_000)
    retry.unref?.()
    const stop = setTimeout(() => {
      clearInterval(retry)
    }, 300_000)
    stop.unref?.()

    return async () => {
      events.abort()
      clearInterval(retry)
      clearTimeout(stop)
      for (const registration of registrations.toReversed()) {
        await registration.dispose()
      }
    }
  },
})
