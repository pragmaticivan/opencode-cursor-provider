import { asSessionID, type OpencodeSessionID } from "../ids.ts"
import type { TurnScope } from "./binding.ts"

export const SENTINEL_VERSION = 1
const PREFIX = `<!-- opencode-cursor-provider:${SENTINEL_VERSION}:`

export function encodeSentinel(scope: TurnScope): string {
  return `${PREFIX}${JSON.stringify({ sessionID: scope.sessionID, cwd: scope.cwd })} -->`
}

export function decodeSentinel(text: string): TurnScope | undefined {
  const start = text.indexOf(PREFIX)
  if (start === -1) return undefined
  const jsonStart = start + PREFIX.length
  const end = text.indexOf(" -->", jsonStart)
  if (end === -1) return undefined
  try {
    const parsed: unknown = JSON.parse(text.slice(jsonStart, end))
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as { sessionID?: unknown; cwd?: unknown }
    if (typeof record.sessionID !== "string" || typeof record.cwd !== "string") return undefined
    if (record.sessionID.length === 0 || record.cwd.length === 0) return undefined
    return { sessionID: asSessionID(record.sessionID), cwd: record.cwd }
  } catch {
    return undefined
  }
}

export function stampSystem(system: string[], scope: TurnScope): string[] {
  const marker = encodeSentinel(scope)
  if (system.some((line) => line.includes(PREFIX))) {
    return system.map((line) => (line.includes(PREFIX) ? marker : line))
  }
  return [...system, marker]
}

export function extractScope(system: readonly string[]): {
  readonly scope: TurnScope | undefined
  readonly system: readonly string[]
} {
  let scope: TurnScope | undefined
  const cleaned: string[] = []
  for (const line of system) {
    const found = decodeSentinel(line)
    if (found) {
      scope = found
      continue
    }
    cleaned.push(line)
  }
  return { scope, system: cleaned }
}

export function sessionFromId(sessionID: string, cwd: string): TurnScope {
  return { sessionID: asSessionID(sessionID) satisfies OpencodeSessionID, cwd }
}
