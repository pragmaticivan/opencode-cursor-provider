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
      { type: "tool-result", id: "call", name: "read", result: { text: "file" }, isError: false },
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
        result: { text: "file" },
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

  test("preserves all usage categories", async () => {
    const result = await modelFor([
      { type: "usage", input: 100, output: 40, cacheRead: 20, cacheWrite: 10, reasoning: 15 },
      { type: "done", reason: "stop" },
    ]).doGenerate(call)

    expect(result.usage).toEqual({
      inputTokens: { total: 100, noCache: 70, cacheRead: 20, cacheWrite: 10 },
      outputTokens: { total: 40, text: 25, reasoning: 15 },
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

  test("rejects file input instead of dropping it", async () => {
    const generated = modelFor([]).doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "file", data: "aGVsbG8=", mediaType: "image/png" }],
        },
      ],
    })
    await expect(generated).rejects.toThrow("file-input")
  })

  test("failed streams do not emit a successful finish", async () => {
    const { stream } = await modelFor([{ type: "failed", error: { kind: "agent-run-failed", detail: "boom" } }]).doStream(
      call,
    )
    const parts = await Array.fromAsync(stream)
    expect(parts.some((part) => part.type === "finish")).toBe(false)
    expect(parts.some((part) => part.type === "error")).toBe(true)
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
    }
    const { stream } = await toLanguageModel({
      bridge,
      modelID: asCatalogModelID("model"),
      wireID: "model",
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
})
