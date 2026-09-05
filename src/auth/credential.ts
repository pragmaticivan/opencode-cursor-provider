import { ENV_NAME, asEpochMs, fail, ok, parseApiKey, type CursorApiKey, type EpochMs, type Parsed } from "../ids.ts"

export type CursorCredential =
  | {
      readonly kind: "oauth"
      readonly apiKey: CursorApiKey
      readonly expiresAt: EpochMs
      readonly email?: string
    }
  | { readonly kind: "key"; readonly apiKey: CursorApiKey }
  | { readonly kind: "env"; readonly apiKey: CursorApiKey; readonly variable: typeof ENV_NAME }

export type RenewalPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "reauth-required"; readonly at: EpochMs }

export function renewalPolicy(credential: CursorCredential): RenewalPolicy {
  if (credential.kind === "oauth") return { kind: "reauth-required", at: credential.expiresAt }
  return { kind: "none" }
}

export function credentialKey(credential: CursorCredential): CursorApiKey {
  return credential.apiKey
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function fromHostCredential(stored: unknown, env: NodeJS.ProcessEnv = process.env): Parsed<CursorCredential> {
  if (!isRecord(stored)) return fail("stored credential is not an object")

  if (stored.type === "oauth") {
    const key = parseApiKey(stored.access)
    if (!key.ok) return key
    const email =
      isRecord(stored.metadata) && typeof stored.metadata.email === "string" ? stored.metadata.email : undefined
    const expiresAt = parseExpires(stored.expires)
    if (expiresAt === undefined) {
      return ok({ kind: "key", apiKey: key.value })
    }
    return ok({
      kind: "oauth",
      apiKey: key.value,
      expiresAt,
      ...(email === undefined ? {} : { email }),
    })
  }

  if (stored.type === "key") {
    const key = parseApiKey(stored.key)
    if (!key.ok) return key
    return ok({ kind: "key", apiKey: key.value })
  }

  if (stored.type === "env") {
    const name = stored.name === ENV_NAME ? ENV_NAME : ENV_NAME
    const key = parseApiKey(env[name])
    if (!key.ok) return fail(`${name} is not set`)
    return ok({ kind: "env", apiKey: key.value, variable: name })
  }

  return fail("unknown credential type")
}

export function envCredential(env: NodeJS.ProcessEnv = process.env): Parsed<CursorCredential> {
  const key = parseApiKey(env[ENV_NAME])
  if (!key.ok) return fail(`${ENV_NAME} is not set`)
  return ok({ kind: "env", apiKey: key.value, variable: ENV_NAME })
}

export function oauthFromLogin(input: {
  apiKey: string
  email?: string
  apiKeyExpiresAtMs: number
}): Parsed<Extract<CursorCredential, { kind: "oauth" }>> {
  const key = parseApiKey(input.apiKey)
  if (!key.ok) return key
  return ok({
    kind: "oauth",
    apiKey: key.value,
    expiresAt: asEpochMs(input.apiKeyExpiresAtMs),
    ...(input.email === undefined ? {} : { email: input.email }),
  })
}

export function keyFromPaste(raw: string): Parsed<CursorCredential> {
  const key = parseApiKey(raw)
  if (!key.ok) return key
  return ok({ kind: "key", apiKey: key.value })
}

function parseExpires(value: unknown): EpochMs | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  const ms = value >= 1_000_000_000 && value < 1_000_000_000_000 ? value * 1000 : value
  return asEpochMs(ms)
}

export function toHostOAuth(credential: Extract<CursorCredential, { kind: "oauth" }>): {
  type: "oauth"
  methodID: string
  refresh: ""
  access: string
  expires: number
  metadata?: { email: string }
} {
  return {
    type: "oauth",
    methodID: "oauth",
    refresh: "",
    access: credential.apiKey,
    expires: credential.expiresAt,
    ...(credential.email === undefined ? {} : { metadata: { email: credential.email } }),
  }
}

