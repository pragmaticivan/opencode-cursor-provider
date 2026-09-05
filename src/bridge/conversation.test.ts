import { describe, expect, test } from "bun:test"
import { newUserTurns, render, userTurns, type Conversation } from "./conversation.ts"

const conversation: Conversation = {
  system: ["be brief"],
  turns: [
    { role: "user", text: "one" },
    { role: "assistant", text: "ok" },
    { role: "user", text: "two" },
  ],
}

describe("conversation", () => {
  test("counts only user turns", () => {
    expect(userTurns(conversation)).toBe(2)
  })

  test("resume prompt is only the new user turns", () => {
    expect(newUserTurns(conversation, 1)).toEqual([{ role: "user", text: "two" }])
  })

  test("fresh prompt includes system and roles", () => {
    expect(render(conversation.system, conversation.turns)).toContain("be brief")
    expect(render(conversation.system, conversation.turns)).toContain("User: two")
  })
})
