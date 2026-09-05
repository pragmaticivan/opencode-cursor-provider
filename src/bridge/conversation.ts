import type { SDKUserMessage } from "@cursor/sdk"
import { createHash } from "node:crypto"

export interface CursorImage {
  readonly data: string
  readonly mimeType: string
}

export type UserPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly image: CursorImage }

export type AssistantPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly input: string }
  | {
      readonly type: "tool-result"
      readonly id: string
      readonly name: string
      readonly output: readonly UserPart[]
      readonly isError: boolean
    }

export type ToolPart =
  | Extract<AssistantPart, { type: "tool-result" }>
  | { readonly type: "tool-approval"; readonly id: string; readonly approved: boolean; readonly reason?: string }

export type ConversationTurn =
  | { readonly role: "user"; readonly parts: readonly UserPart[] }
  | { readonly role: "assistant"; readonly parts: readonly AssistantPart[] }
  | { readonly role: "tool"; readonly parts: readonly ToolPart[] }

export interface Conversation {
  readonly system: readonly string[]
  readonly turns: readonly ConversationTurn[]
}

export interface ConversationCheckpoint {
  readonly system: string
  readonly turns: readonly string[]
}

export function render(system: readonly string[], turns: readonly ConversationTurn[]): string {
  return renderCursorMessage(system, turns).text
}

export function cursorMessage(system: readonly string[], turns: readonly ConversationTurn[]): string | SDKUserMessage {
  const message = renderCursorMessage(system, turns)
  return message.images === undefined ? message.text : message
}

export function checkpointOf(conversation: Conversation): ConversationCheckpoint {
  return {
    system: digest(conversation.system),
    turns: conversation.turns.map(digest),
  }
}

export function resumeTurn(
  conversation: Conversation,
  checkpoint: ConversationCheckpoint,
): Extract<ConversationTurn, { role: "user" }> | undefined {
  if (digest(conversation.system) !== checkpoint.system) return undefined
  if (conversation.turns.length !== checkpoint.turns.length + 1) return undefined
  for (let index = 0; index < checkpoint.turns.length; index += 1) {
    const turn = conversation.turns[index]
    if (turn === undefined || digest(turn) !== checkpoint.turns[index]) return undefined
  }
  const suffix = conversation.turns.at(-1)
  return suffix?.role === "user" ? suffix : undefined
}

export function extendsCheckpoint(conversation: Conversation, checkpoint: ConversationCheckpoint): boolean {
  return resumeTurn(conversation, checkpoint) !== undefined
}

export function toolResultsAfter(
  conversation: Conversation,
  checkpoint: ConversationCheckpoint,
  calls: readonly { readonly id: string; readonly name: string }[],
): readonly Extract<ToolPart, { type: "tool-result" }>[] | undefined {
  if (digest(conversation.system) !== checkpoint.system) return undefined
  if (conversation.turns.length !== checkpoint.turns.length + 1) return undefined
  for (let index = 0; index < checkpoint.turns.length; index += 1) {
    const turn = conversation.turns[index]
    if (turn === undefined || digest(turn) !== checkpoint.turns[index]) return undefined
  }
  const suffix = conversation.turns.at(-1)
  if (suffix?.role !== "tool") return undefined
  if (suffix.parts.length !== calls.length) return undefined
  const expected = new Map(calls.map((call) => [call.id, call.name]))
  if (expected.size !== calls.length) return undefined
  const found = new Set<string>()
  const results: Array<Extract<ToolPart, { type: "tool-result" }>> = []
  for (const part of suffix.parts) {
    if (part.type !== "tool-result") return undefined
    if (expected.get(part.id) !== part.name || found.has(part.id)) return undefined
    found.add(part.id)
    results.push(part)
  }
  return results
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(ordered(value)) ?? "null"
}

function renderCursorMessage(
  system: readonly string[],
  turns: readonly ConversationTurn[],
): { readonly text: string; readonly images?: CursorImage[] } {
  const sections: string[] = []
  const images: CursorImage[] = []
  for (const instruction of system) sections.push(`System: ${instruction}`)
  for (const turn of turns) {
    const role = turn.role === "user" ? "User" : turn.role === "assistant" ? "Assistant" : "Tool"
    const parts = turn.parts.map((part) => renderPart(part, images))
    sections.push(`${role}: ${parts.join("\n\n")}`)
  }
  const text = sections.join("\n\n")
  return images.length === 0 ? { text } : { text, images }
}

function renderPart(part: UserPart | AssistantPart | ToolPart, images: CursorImage[]): string {
  switch (part.type) {
    case "text":
      return part.text
    case "image":
      images.push(part.image)
      return `[Image ${images.length}: ${part.image.mimeType}]`
    case "reasoning":
      return `[Reasoning]\n${part.text}`
    case "tool-call":
      return `[Tool call ${part.name} (${part.id})]\n${part.input}`
    case "tool-result":
      return [
        `[Tool ${part.isError ? "error" : "result"} ${part.name} (${part.id})]`,
        ...part.output.map((output) => renderPart(output, images)),
      ].join("\n")
    case "tool-approval":
      return `[Tool approval ${part.id}]\n${part.approved ? "approved" : "denied"}${part.reason ? `: ${part.reason}` : ""}`
    default: {
      const _exhaustive: never = part
      return _exhaustive
    }
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function ordered(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value !== "object") return String(value)
  if (Array.isArray(value)) return value.map(ordered)
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, ordered(Object.getOwnPropertyDescriptor(value, key)?.value)]),
  )
}

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue }
