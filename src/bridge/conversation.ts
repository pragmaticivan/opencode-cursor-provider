export interface ConversationTurn {
  readonly role: "user" | "assistant"
  readonly text: string
}

export interface Conversation {
  readonly system: readonly string[]
  readonly turns: readonly ConversationTurn[]
}

export function userTurns(conversation: Conversation): number {
  return conversation.turns.filter((turn) => turn.role === "user").length
}

export function render(system: readonly string[], turns: readonly ConversationTurn[]): string {
  const parts: string[] = []
  if (system.length > 0) {
    parts.push(system.join("\n\n"))
  }
  for (const turn of turns) {
    parts.push(`${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
  }
  return parts.join("\n\n")
}

export function newUserTurns(conversation: Conversation, forwardedTurns: number): readonly ConversationTurn[] {
  let seen = 0
  const extra: ConversationTurn[] = []
  for (const turn of conversation.turns) {
    if (turn.role !== "user") continue
    seen += 1
    if (seen > forwardedTurns) extra.push(turn)
  }
  return extra
}
