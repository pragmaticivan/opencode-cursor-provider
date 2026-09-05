import { describe, expect, test } from "bun:test"
import {
  canonicalJson,
  checkpointOf,
  cursorMessage,
  extendsCheckpoint,
  render,
  resumeTurn,
  toolResultsAfter,
  type Conversation,
} from "./conversation.ts"

const conversation: Conversation = {
  system: ["be brief"],
  turns: [
    { role: "user", parts: [{ type: "text", text: "one" }] },
    { role: "assistant", parts: [{ type: "text", text: "ok" }] },
    { role: "user", parts: [{ type: "text", text: "two" }] },
  ],
}

describe("conversation", () => {
  test("resume prompt is exactly one new user turn", () => {
    const checkpoint = checkpointOf({ ...conversation, turns: conversation.turns.slice(0, -1) })
    expect(resumeTurn(conversation, checkpoint)).toEqual({
      role: "user",
      parts: [{ type: "text", text: "two" }],
    })
  })

  test("fresh prompt includes system and roles", () => {
    expect(render(conversation.system, conversation.turns)).toContain("be brief")
    expect(render(conversation.system, conversation.turns)).toContain("User: two")
  })

  test("the Cursor prompt associates each image with its source turn", () => {
    const message = cursorMessage([], [
      {
        role: "user",
        parts: [
          { type: "text", text: "first" },
          { type: "image", image: { data: "one", mimeType: "image/png" } },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        parts: [
          { type: "text", text: "second" },
          { type: "image", image: { data: "two", mimeType: "image/jpeg" } },
        ],
      },
    ])
    expect(message).toEqual({
      text: "User: first\n\n[Image 1: image/png]\n\nAssistant: ok\n\nUser: second\n\n[Image 2: image/jpeg]",
      images: [
        { data: "one", mimeType: "image/png" },
        { data: "two", mimeType: "image/jpeg" },
      ],
    })
  })

  test("a checkpoint ignores object key order", () => {
    const left = checkpointOf({
      system: [],
      turns: [
        {
          role: "assistant",
          parts: [{ type: "tool-call", name: "read", id: "call", input: canonicalJson({ path: "a.ts", limit: 10 }) }],
        },
      ],
    })
    const right = checkpointOf({
      system: [],
      turns: [
        {
          role: "assistant",
          parts: [{ type: "tool-call", name: "read", id: "call", input: canonicalJson({ limit: 10, path: "a.ts" }) }],
        },
      ],
    })
    expect(left).toEqual(right)
  })

  test("a checkpoint distinguishes marker text from structured tool history", () => {
    const text = checkpointOf({
      system: [],
      turns: [{ role: "assistant", parts: [{ type: "text", text: "[Tool call read (call)]\n{}" }] }],
    })
    const tool = checkpointOf({
      system: [],
      turns: [{ role: "assistant", parts: [{ type: "tool-call", name: "read", id: "call", input: "{}" }] }],
    })
    expect(text).not.toEqual(tool)
  })

  test("canonical JSON preserves an own __proto__ key", () => {
    const value = Object.create(null)
    Object.defineProperty(value, "__proto__", { enumerable: true, value: { safe: true } })
    expect(canonicalJson(value)).toBe('{"__proto__":{"safe":true}}')
  })

  test("a checkpoint matches only an unchanged conversation prefix", () => {
    const checkpoint = checkpointOf(conversation)
    expect(
      extendsCheckpoint(
        {
          ...conversation,
          turns: [...conversation.turns, { role: "user", parts: [{ type: "text", text: "three" }] }],
        },
        checkpoint,
      ),
    ).toBe(true)
    expect(
      extendsCheckpoint(
        {
          ...conversation,
          turns: [
            ...conversation.turns,
            { role: "assistant", parts: [{ type: "text", text: "ok" }] },
            { role: "user", parts: [{ type: "text", text: "three" }] },
          ],
        },
        checkpoint,
      ),
    ).toBe(false)
    expect(
      extendsCheckpoint(
        {
          ...conversation,
          turns: [{ role: "user", parts: [{ type: "text", text: "changed" }] }, ...conversation.turns.slice(1)],
        },
        checkpoint,
      ),
    ).toBe(false)
  })

  test("accepts only the expected tool results after a checkpoint", () => {
    const checkpoint = checkpointOf(conversation)
    const continued: Conversation = {
      ...conversation,
      turns: [
        ...conversation.turns,
        {
          role: "tool",
          parts: [
            {
              type: "tool-result",
              id: "bridge-1",
              name: "docs_search",
              output: [{ type: "text", text: "found" }],
              isError: false,
            },
          ],
        },
      ],
    }

    expect(toolResultsAfter(continued, checkpoint, [{ id: "bridge-1", name: "docs_search" }])).toEqual([
      {
        type: "tool-result",
        id: "bridge-1",
        name: "docs_search",
        output: [{ type: "text", text: "found" }],
        isError: false,
      },
    ])
    expect(toolResultsAfter(continued, checkpoint, [{ id: "stale-call", name: "docs_search" }])).toBeUndefined()
    expect(toolResultsAfter(continued, checkpoint, [{ id: "bridge-1", name: "wrong_tool" }])).toBeUndefined()
    expect(
      toolResultsAfter({ ...continued, system: ["changed"] }, checkpoint, [
        { id: "bridge-1", name: "docs_search" },
      ]),
    ).toBeUndefined()
  })
})
