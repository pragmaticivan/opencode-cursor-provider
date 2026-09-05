import { AuthenticationError, Cursor } from "@cursor/sdk"
import type { Plugin } from "@opencode-ai/plugin"
import type { CursorLink } from "../auth/link.ts"
import { parseListedModels, SEED_MODELS, type CursorModelDescriptor } from "./catalog.ts"

export interface ModelSource {
  list(): readonly CursorModelDescriptor[]
  refresh(ctx: Plugin.Context): Promise<void>
}

export function createModelSource(link: CursorLink): ModelSource {
  let models: CursorModelDescriptor[] = [...SEED_MODELS]

  return {
    list() {
      return models
    },
    async refresh(ctx) {
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
    },
  }
}
