import { Cursor } from "@cursor/sdk"
import { Credential, Integration, Plugin } from "@opencode-ai/plugin"
import type { IntegrationEditor } from "@opencode-ai/plugin/promise/integration"
import { ENV_NAME, INTEGRATION_ID, OAUTH_METHOD_ID, nowMs, type Parsed } from "../ids.ts"
import { envCredential, fromHostCredential, oauthFromLogin, toHostOAuth, type CursorCredential } from "./credential.ts"
import { reduce, usableKey, type AuthState } from "./state.ts"

export interface CursorLink {
  resolve(): Promise<ReturnType<typeof usableKey>>
  register(draft: IntegrationEditor): void
  restore(ctx: Plugin.Context): Promise<void>
  reject(): void
  onLinked(listener: () => void): () => void
}

export function createCursorLink(input: { env?: NodeJS.ProcessEnv; clock?: () => number } = {}): CursorLink {
  const env = input.env ?? process.env
  const clock = input.clock ?? Date.now
  let state: AuthState = { status: "unlinked" }
  const listeners = new Set<() => void>()

  function emit(): void {
    for (const listener of listeners) listener()
  }

  function assign(next: AuthState): void {
    state = next
  }

  return {
    async resolve() {
      assign(reduce(state, { type: "tick", now: nowMs(clock) }))
      return usableKey(state)
    },
    reject() {
      assign(reduce(state, { type: "rejected-by-cursor" }))
    },
    async restore(ctx) {
      assign(reduce(state, { type: "restore", stored: await loadStored(ctx, env), now: nowMs(clock) }))
    },
    onLinked(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    register(draft) {
      draft.update(INTEGRATION_ID, (integration) => {
        integration.id = INTEGRATION_ID
        integration.name = "Cursor"
      })

      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: OAUTH_METHOD_ID,
          type: "oauth",
          label: "Cursor account (browser login)",
        },
        authorize: async () => {
          const abort = new AbortController()
          let settleUrl: (url: string) => void = () => {}
          const url = new Promise<string>((resolve) => {
            settleUrl = resolve
          })
          const login = Cursor.auth.login({
            openBrowser: false,
            onLoginUrl: settleUrl,
            store: null,
            signal: abort.signal,
            apiKeyName: "OpenCode",
          })
          const loginUrl = await url
          assign(
            reduce(state, {
              type: "login-started",
            }),
          )
          return {
            url: loginUrl,
            instructions: "Open this URL in a browser to sign in to Cursor.",
            mode: "auto" as const,
            callback: login.then((result) => {
              const parsed = oauthFromLogin(result)
              if (!parsed.ok) {
                assign(reduce(state, { type: "login-failed" }))
                throw new Error(parsed.issue)
              }
              assign(reduce(state, { type: "login-succeeded", credential: parsed.value, now: nowMs(clock) }))
              emit()
              const host = toHostOAuth(parsed.value)
              return {
                type: "oauth" as const,
                methodID: Integration.MethodID.make(OAUTH_METHOD_ID),
                refresh: host.refresh,
                access: host.access,
                expires: host.expires,
                ...(host.metadata === undefined ? {} : { metadata: host.metadata }),
              } satisfies Credential.OAuth
            }),
          }
        },
        label: (credential) => {
          const email =
            credential.metadata && typeof credential.metadata.email === "string" ? credential.metadata.email : undefined
          return email ?? "Cursor account"
        },
      })

      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "key", label: "API key (cursor.com/settings)" },
      })

      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "env", names: [ENV_NAME] },
      })
    },
  }
}

async function loadStored(ctx: Plugin.Context, env: NodeJS.ProcessEnv): Promise<Parsed<CursorCredential>> {
  try {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID)
    if (connection) {
      const stored = await ctx.integration.connection.resolve(connection)
      if (stored) return fromHostCredential(stored, env)
    }
  } catch {
    // Host lookup is best-effort. CURSOR_API_KEY is the fallback.
  }
  return envCredential(env)
}
