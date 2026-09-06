import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { describe, expect, test } from "bun:test"
import type { SessionAgentBridge, TurnRequest } from "../bridge/bridge.ts"
import type { TurnEvent } from "../bridge/translate.ts"
import { CursorPluginFailure } from "../errors.ts"
import { asCatalogModelID } from "../ids.ts"
import { toLanguageModel } from "./language-model.ts"

function modelFor(events: readonly TurnEvent[], requests: TurnRequest[] = []) {
  const bridge: SessionAgentBridge = {
    annotate(system) {
      return system
    },
    async *turn(request) {
      requests.push(request)
      yield* events
    },
    async dispose() {},
    async cancel() {},
  }
  return toLanguageModel({
    bridge,
    modelID: asCatalogModelID("model"),
    wireID: "model",
    params: [{ id: "thinking", value: "high" }],
  })
}

const call: LanguageModelV3CallOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
}

describe("Cursor request boundary", () => {
  test("passes selected Cursor parameters into the turn", async () => {
    const requests: TurnRequest[] = []
    await modelFor([{ type: "done", reason: "stop" }], requests).doGenerate(call)
    expect(requests[0]?.params).toEqual([{ id: "thinking", value: "high" }])
  })

  test("passes OpenCode tools into the Cursor turn", async () => {
    const requests: TurnRequest[] = []
    await modelFor([{ type: "done", reason: "stop" }], requests).doGenerate({
      ...call,
      tools: [
        {
          type: "function",
          name: "docs_search",
          description: "Search the documentation",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    })

    expect(requests[0]).toMatchObject({
      tools: [
        {
          name: "docs_search",
          description: "Search the documentation",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    })
  })

  test("passes image input into the Cursor turn", async () => {
    const requests: TurnRequest[] = []
    await modelFor([{ type: "done", reason: "stop" }], requests).doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "file", data: "aGVsbG8=", mediaType: "image/png" },
          ],
        },
      ],
    })
    expect(requests[0]?.conversation.turns).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "describe this" },
          { type: "image", image: { data: "aGVsbG8=", mimeType: "image/png" } },
        ],
      },
    ])
  })

  test("converts image bytes and rejects image URLs", async () => {
    const requests: TurnRequest[] = []
    await modelFor([{ type: "done", reason: "stop" }], requests).doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "file", data: new Uint8Array([104, 105]), mediaType: "image/png" }],
        },
      ],
    })
    expect(requests[0]?.conversation.turns[0]).toEqual({
      role: "user",
      parts: [{ type: "image", image: { data: "aGk=", mimeType: "image/png" } }],
    })

    await expect(
      modelFor([]).doGenerate({
        prompt: [{ role: "user", content: [{ type: "file", data: new URL("https://example.com/a.png"), mediaType: "image/png" }] }],
      }),
    ).rejects.toThrow("file-input")
  })

  test("rejects non-image file input", async () => {
    const generated = modelFor([]).doGenerate({
      prompt: [{ role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "text/plain" }] }],
    })
    await expect(generated).rejects.toThrow("file-input")
    await expect(
      modelFor([]).doGenerate({
        prompt: [{ role: "user", content: [{ type: "file", data: "aGVsbG8=", mediaType: "image/*" }] }],
      }),
    ).rejects.toThrow("file-input")
  })

  test("preserves assistant reasoning and tool history for fresh agents", async () => {
    const requests: TurnRequest[] = []
    await modelFor([{ type: "done", reason: "stop" }], requests).doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "inspect" },
            { type: "tool-call", toolCallId: "call", toolName: "read", input: { path: "a.ts" }, providerExecuted: true },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "file" } }],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    })
    expect(requests[0]?.conversation.turns).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "inspect" },
          { type: "tool-call", id: "call", name: "read", input: '{"path":"a.ts"}' },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool-result",
            id: "call",
            name: "read",
            output: [{ type: "text", text: "file" }],
            isError: false,
          },
        ],
      },
      { role: "user", parts: [{ type: "text", text: "continue" }] },
    ])
  })

  test("preserves image content in tool results and rejects other files", async () => {
    const requests: TurnRequest[] = []
    await modelFor([{ type: "done", reason: "stop" }], requests).doGenerate({
      prompt: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call",
              toolName: "view",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "image" },
                  { type: "image-data", data: "aGVsbG8=", mediaType: "image/png" },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(requests[0]?.conversation.turns).toEqual([
      {
        role: "tool",
        parts: [
          {
            type: "tool-result",
            id: "call",
            name: "view",
            output: [
              { type: "text", text: "image" },
              { type: "image", image: { data: "aGVsbG8=", mimeType: "image/png" } },
            ],
            isError: false,
          },
        ],
      },
    ])

    await expect(
      modelFor([]).doGenerate({
        prompt: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call",
                toolName: "read",
                output: {
                  type: "content",
                  value: [{ type: "file-data", data: "aGVsbG8=", mediaType: "text/plain" }],
                },
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow("file-input")
  })

  test("preserves interleaved user text and image order", async () => {
    const requests: TurnRequest[] = []
    await modelFor([{ type: "done", reason: "stop" }], requests).doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "file", data: "aGVsbG8=", mediaType: "image/png" },
            { type: "text", text: "after" },
          ],
        },
      ],
    })
    expect(requests[0]?.conversation.turns).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "before" },
          { type: "image", image: { data: "aGVsbG8=", mimeType: "image/png" } },
          { type: "text", text: "after" },
        ],
      },
    ])
  })

  test("warns on sampling controls Cursor does not honor", async () => {
    const result = await modelFor([{ type: "done", reason: "stop" }]).doGenerate({
      ...call,
      temperature: 0.2,
    })
    expect(result.warnings).toEqual([{ type: "unsupported", feature: "temperature" }])
  })

  test("warns for every ignored request option", async () => {
    const result = await modelFor([{ type: "done", reason: "stop" }]).doGenerate({
      ...call,
      stopSequences: ["stop"],
      presencePenalty: 0.2,
      frequencyPenalty: 0.3,
      seed: 1,
      headers: { "x-test": "value" },
      providerOptions: { other: { value: true } },
    })
    expect(result.warnings).toEqual([
      { type: "unsupported", feature: "stopSequences" },
      { type: "unsupported", feature: "presencePenalty" },
      { type: "unsupported", feature: "frequencyPenalty" },
      { type: "unsupported", feature: "seed" },
      { type: "unsupported", feature: "headers" },
      { type: "unsupported", feature: "providerOptions.other" },
    ])
  })

  test("warns when message or content provider options cannot be applied", async () => {
    const result = await modelFor([{ type: "done", reason: "stop" }]).doGenerate({
      prompt: [
        {
          role: "user",
          providerOptions: { other: { message: true } },
          content: [
            {
              type: "text",
              text: "hello",
              providerOptions: { other: { part: true } },
            },
          ],
        },
      ],
    })
    expect(result.warnings).toEqual([
      { type: "unsupported", feature: "message.providerOptions" },
      { type: "unsupported", feature: "content.providerOptions" },
    ])
  })

  test("forwards the Cursor mode provider option", async () => {
    const requests: TurnRequest[] = []
    await modelFor([{ type: "done", reason: "stop" }], requests).doGenerate({
      ...call,
      providerOptions: { cursor: { mode: "plan" } },
    })
    expect(requests[0]?.mode).toBe("plan")
  })

  test("forwards safe local Cursor agent options", async () => {
    const requests: TurnRequest[] = []
    const result = await modelFor([{ type: "done", reason: "stop" }], requests).doGenerate({
      ...call,
      providerOptions: {
        cursor: {
          tools: ["read", "grep"],
          disallowedTools: ["shell"],
          sandboxOptions: { enabled: true },
          autoReview: true,
          settingSources: ["project", "team"],
        },
      },
    })
    expect(requests[0]?.agentOptions).toEqual({
      tools: ["read", "grep"],
      disallowedTools: ["shell"],
      sandboxOptions: { enabled: true },
      autoReview: true,
      settingSources: ["project", "team"],
    })
    expect(result.warnings).toEqual([])
  })

  test("rejects invalid local Cursor agent options", async () => {
    await expect(
      modelFor([]).doGenerate({
        ...call,
        providerOptions: { cursor: { settingSources: ["project", "invalid"] } },
      }),
    ).rejects.toThrow("provider-option")
    await expect(
      modelFor([]).doGenerate({
        ...call,
        providerOptions: { cursor: { sandboxOptions: { enabled: "yes" } } },
      }),
    ).rejects.toThrow("provider-option")
  })

  test("rejects unsupported tool choice and invalid Cursor mode", async () => {
    await expect(modelFor([]).doGenerate({ ...call, toolChoice: { type: "none" } })).rejects.toThrow("tool-choice")
    await expect(
      modelFor([]).doGenerate({ ...call, providerOptions: { cursor: { mode: "invalid" } } }),
    ).rejects.toThrow("provider-option")
  })
})
