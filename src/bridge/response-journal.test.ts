import { describe, expect, test } from "bun:test"
import { createResponseJournal } from "./response-journal.ts"

describe("response journal", () => {
  test("uses one deduplication policy for emitted events and saved parts", () => {
    const journal = createResponseJournal()
    const events = [
      { type: "tool-call", id: "call", name: "read", input: { path: "a.ts" } } as const,
      { type: "tool-call", id: "call", name: "read", input: { path: "a.ts" } } as const,
      { type: "tool-result", id: "call", name: "read", result: "ok", isError: false } as const,
      { type: "tool-result", id: "call", name: "read", result: "ok", isError: false } as const,
    ]

    expect(events.flatMap((event) => journal.accept(event) ?? [])).toHaveLength(2)
    expect(journal.parts()).toEqual([
      { type: "tool-call", id: "call", name: "read", input: '{"path":"a.ts"}' },
      {
        type: "tool-result",
        id: "call",
        name: "read",
        output: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ])
  })

  test("merges only adjacent text and reasoning parts", () => {
    const journal = createResponseJournal()
    journal.accept({ type: "text", delta: "one" })
    journal.accept({ type: "text", delta: " two" })
    journal.accept({ type: "reasoning", delta: "think" })
    journal.accept({ type: "text", delta: "three" })

    expect(journal.parts()).toEqual([
      { type: "text", text: "one two" },
      { type: "reasoning", text: "think" },
      { type: "text", text: "three" },
    ])
  })
})
