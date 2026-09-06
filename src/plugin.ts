import { Plugin } from "@opencode-ai/plugin"
import { createCursorLink } from "./auth/link.ts"
import { createSessionAgentBridge } from "./bridge/bridge.ts"
import { sessionFromId } from "./bridge/correlation.ts"
import { applyModels, applyProvider, modelParamsFromOptions } from "./catalog/catalog.ts"
import { createModelSource } from "./catalog/source.ts"
import { asCatalogModelID, asSessionID, PROVIDER_ID } from "./ids.ts"
import { toLanguageModel } from "./model/language-model.ts"
import { bindRuntime } from "./runtime.ts"

const REFRESH_EVERY_MS = 5_000
const REFRESH_FOR_MS = 300_000

export const plugin = Plugin.define({
  id: "opencode-cursor-provider",
  async setup(ctx) {
    const link = createCursorLink()
    const models = createModelSource({
      restoreCredential: () => link.restore(ctx),
      resolveApiKey: () => link.resolve(),
      rejectCredential: () => link.reject(),
      reloadCatalog: () => ctx.catalog.reload(),
    })
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
        params: modelParamsFromOptions(options),
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

    const stopRefresh = watchModels({
      onLinked: (listener) => link.onLinked(listener),
      subscribe: (signal) => ctx.event.subscribe({ signal }),
      onEvent: async (event) => {
        const sessionID = endedSessionID(event)
        if (sessionID !== undefined) await bridge.cancel(asSessionID(sessionID), "The OpenCode session stopped")
      },
      refresh: () => models.refresh(),
      close: () => models.close(),
    })

    return async () => {
      await stopRefresh()
      await bridge.dispose()
      for (const registration of registrations.toReversed()) {
        await registration.dispose()
      }
    }
  },
})

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

export interface ModelWatcherDependencies {
  onLinked(listener: () => void): () => void
  subscribe(signal: AbortSignal): AsyncIterable<{ readonly type: string; readonly data?: unknown }>
  onEvent?(event: { readonly type: string; readonly data?: unknown }): Promise<void> | void
  refresh(): Promise<void>
  close(): Promise<void>
}

export function watchModels(dependencies: ModelWatcherDependencies): () => Promise<void> {
  const events = new AbortController()
  let stopped = false
  let cleanup: Promise<void> | undefined
  const refresh = () => {
    if (stopped) return
    void dependencies.refresh().catch(() => {})
  }

  const stopLinked = dependencies.onLinked(refresh)
  refresh()

  const eventTask = (async () => {
    try {
      for await (const event of dependencies.subscribe(events.signal)) {
        await dependencies.onEvent?.(event)
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
    if (cleanup !== undefined) return cleanup
    cleanup = (async () => {
      stopped = true
      stopLinked()
      events.abort()
      clearInterval(retry)
      clearTimeout(stop)
      await eventTask
      await dependencies.close()
    })()
    return cleanup
  }
}

function endedSessionID(event: { readonly type: string; readonly data?: unknown }): string | undefined {
  if (event.type !== "session.idle" && event.type !== "session.deleted") return undefined
  if (typeof event.data !== "object" || event.data === null || !("sessionID" in event.data)) return undefined
  return typeof event.data.sessionID === "string" ? event.data.sessionID : undefined
}
