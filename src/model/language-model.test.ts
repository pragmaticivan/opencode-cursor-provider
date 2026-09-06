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

describe("Cursor language model", () => {
  test("doGenerate preserves ordered native content", async () => {
    const result = await modelFor([
      { type: "text", delta: "before" },
      { type: "reasoning", delta: "think" },
      { type: "tool-call", id: "call", name: "read", input: { path: "a.ts" } },
      {
        type: "tool-result",
        id: "call",
        name: "read",
        result: "file",
        isError: false,
      },
      { type: "text", delta: "after" },
      { type: "done", reason: "stop" },
    ]).doGenerate(call)

    expect(result.content).toEqual([
      { type: "text", text: "before" },
      { type: "reasoning", text: "think" },
      {
        type: "tool-call",
        toolCallId: "call",
        toolName: "read",
        input: '{"path":"a.ts"}',
        providerExecuted: true,
        dynamic: true,
      },
      {
        type: "tool-result",
        toolCallId: "call",
        toolName: "read",
        result: "file",
        isError: false,
        dynamic: true,
      },
      { type: "text", text: "after" },
    ])
  })

  test("deduplicates running and completed tool updates", async () => {
    const { stream } = await modelFor([
      { type: "tool-call", id: "call", name: "read", input: { path: "a.ts" } },
      { type: "tool-call", id: "call", name: "read", input: { path: "a.ts" } },
      { type: "tool-result", id: "call", name: "read", result: "ok", isError: false },
      { type: "tool-result", id: "call", name: "read", result: "ok", isError: false },
      { type: "done", reason: "stop" },
    ]).doStream(call)
    const parts = await Array.fromAsync(stream)

    expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(1)
    expect(parts.filter((part) => part.type === "tool-result")).toHaveLength(1)
  })

  test("returns OpenCode tool requests for OpenCode to execute", async () => {
    const result = await modelFor([
      { type: "tool-request", id: "bridge-call", name: "docs_search", input: { query: "Cursor" } },
      { type: "done", reason: "tool-calls" },
    ]).doGenerate(call)

    expect(result.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "bridge-call",
        toolName: "docs_search",
        input: '{"query":"Cursor"}',
      },
    ])
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: "tool-calls" })
  })

  test("uses a unique ID when an output block type resumes", async () => {
    const { stream } = await modelFor([
      { type: "text", delta: "one" },
      { type: "reasoning", delta: "think" },
      { type: "text", delta: "two" },
      { type: "done", reason: "stop" },
    ]).doStream(call)
    const starts = (await Array.fromAsync(stream)).filter((part) => part.type === "text-start")
    expect(starts).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-start", id: "text-2" },
    ])
  })

  test("preserves all usage categories", async () => {
    const result = await modelFor([
      { type: "usage", input: 100, output: 40, cacheRead: 20, cacheWrite: 10, reasoning: 15, total: 140 },
      { type: "done", reason: "stop" },
    ]).doGenerate(call)

    expect(result.usage).toEqual({
      inputTokens: { total: 100, noCache: 70, cacheRead: 20, cacheWrite: 10 },
      outputTokens: { total: 40, text: 25, reasoning: 15 },
      raw: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        reasoningTokens: 15,
        totalTokens: 140,
      },
    })
  })

  test("doGenerate throws streamed failures", async () => {
    const generated = modelFor([{ type: "failed", error: { kind: "agent-run-failed", detail: "boom" } }]).doGenerate(
      call,
    )
    await expect(generated).rejects.toBeInstanceOf(CursorPluginFailure)
  })

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

  test("failed streams do not emit a successful finish", async () => {
    const { stream } = await modelFor([{ type: "failed", error: { kind: "agent-run-failed", detail: "boom" } }]).doStream(
      call,
    )
    const parts = await Array.fromAsync(stream)
    expect(parts.some((part) => part.type === "finish")).toBe(false)
    expect(parts.some((part) => part.type === "error")).toBe(true)
  })

  test("closes an open content block before a stream error", async () => {
    const { stream } = await modelFor([
      { type: "text", delta: "partial" },
      { type: "failed", error: { kind: "agent-run-failed", detail: "boom" } },
    ]).doStream(call)
    expect((await Array.fromAsync(stream)).map((part) => part.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "error",
    ])
  })

  test("closes an open content block before a thrown iterator error", async () => {
    const bridge: SessionAgentBridge = {
      annotate(system) {
        return system
      },
      async *turn() {
        yield { type: "text", delta: "partial" }
        throw new Error("boom")
      },
      async dispose() {},
      async cancel() {},
    }
    const { stream } = await toLanguageModel({
      bridge,
      modelID: asCatalogModelID("model"),
      wireID: "model",
      params: undefined,
    }).doStream(call)
    expect((await Array.fromAsync(stream)).map((part) => part.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "error",
    ])
  })

  test("stream cancel aborts the Cursor turn", async () => {
    let aborted = false
    const bridge: SessionAgentBridge = {
      annotate(system) {
        return system
      },
      async *turn(request) {
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => {
            aborted = true
            resolve()
          })
        })
        yield { type: "failed", error: { kind: "cancelled" } }
      },
      async dispose() {},
      async cancel() {},
    }
    const { stream } = await toLanguageModel({
      bridge,
      modelID: asCatalogModelID("model"),
      wireID: "model",
      params: undefined,
    }).doStream(call)
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()
    expect(aborted).toBe(true)
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

  test("forwards raw Cursor chunks and response metadata", async () => {
    const requests: TurnRequest[] = []
    const raw = { type: "status" as const, agent_id: "agent", run_id: "run", status: "RUNNING" as const }
    const result = await modelFor(
      [
        { type: "response-metadata", id: "run", timestamp: 1, modelId: "composer-2.5" },
        { type: "raw", value: raw },
        {
          type: "done",
          reason: "stop",
          metadata: {
            runId: "run",
            requestId: "request",
            durationMs: 10,
            modelId: "composer-2.5",
            git: [{ repoUrl: "https://example.com/repo", branch: "main" }],
          },
        },
      ],
      requests,
    ).doGenerate({ ...call, includeRawChunks: true })
    expect(requests[0]?.includeRawChunks).toBe(true)
    expect(result.response).toEqual({ id: "run", timestamp: new Date(1), modelId: "composer-2.5" })
    expect(result.providerMetadata).toEqual({
      cursor: {
        runId: "run",
        requestId: "request",
        durationMs: 10,
        modelId: "composer-2.5",
        git: [{ repoUrl: "https://example.com/repo", branch: "main" }],
      },
    })

    const streamed = await modelFor([{ type: "raw", value: raw }, { type: "done", reason: "stop" }]).doStream({
      ...call,
      includeRawChunks: true,
    })
    expect(await Array.fromAsync(streamed.stream)).toContainEqual({ type: "raw", rawValue: raw })
  })

  test("rejects unsupported tool choice and invalid Cursor mode", async () => {
    await expect(modelFor([]).doGenerate({ ...call, toolChoice: { type: "none" } })).rejects.toThrow("tool-choice")
    await expect(
      modelFor([]).doGenerate({ ...call, providerOptions: { cursor: { mode: "invalid" } } }),
    ).rejects.toThrow("provider-option")
  })
})
