export type Brand<T, B extends string> = T & { readonly __brand: B }

export type CursorApiKey = Brand<string, "CursorApiKey">
export type CursorAgentID = Brand<string, "CursorAgentID">
export type CursorModelID = Brand<string, "CursorModelID">
export type CatalogModelID = Brand<string, "CatalogModelID">
export type OpencodeSessionID = Brand<string, "OpencodeSessionID">
export type EpochMs = Brand<number, "EpochMs">

export const PROVIDER_ID = "cursor"
export const INTEGRATION_ID = "cursor"
export const OAUTH_METHOD_ID = "oauth"
export const PACKAGE_SPEC = "aisdk:@ai-sdk/openai-compatible"
export const ENV_NAME = "CURSOR_API_KEY"

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string }

export function ok<T>(value: T): Parsed<T> {
  return { ok: true, value }
}

export function fail<T>(issue: string): Parsed<T> {
  return { ok: false, issue }
}

export function asApiKey(value: string): CursorApiKey {
  return value as CursorApiKey
}

export function asAgentID(value: string): CursorAgentID {
  return value as CursorAgentID
}

export function asCatalogModelID(value: string): CatalogModelID {
  return value as CatalogModelID
}

export function asCursorModelID(value: string): CursorModelID {
  return value as CursorModelID
}

export function asSessionID(value: string): OpencodeSessionID {
  return value as OpencodeSessionID
}

export function asEpochMs(value: number): EpochMs {
  return value as EpochMs
}

export function parseNonEmpty(value: unknown, label: string): Parsed<string> {
  if (typeof value !== "string") return fail(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return fail(`${label} must not be empty`)
  return ok(trimmed)
}

export function parseApiKey(value: unknown): Parsed<CursorApiKey> {
  const parsed = parseNonEmpty(value, "api key")
  if (!parsed.ok) return parsed
  return ok(asApiKey(parsed.value))
}

export function parseAgentID(value: unknown): Parsed<CursorAgentID> {
  const parsed = parseNonEmpty(value, "agent id")
  if (!parsed.ok) return parsed
  return ok(asAgentID(parsed.value))
}

export function nowMs(clock: () => number = Date.now): EpochMs {
  return asEpochMs(clock())
}
