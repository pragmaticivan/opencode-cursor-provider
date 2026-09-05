import type { ModelParameterValue, Run, RunResult, SDKUserMessage, SendOptions } from "@cursor/sdk"
import { describe, expect, test } from "bun:test"
import { SEED_MODELS } from "../catalog/catalog.ts"
import { asAgentID, asApiKey, asCatalogModelID, asEpochMs, asSessionID } from "../ids.ts"
import { createBindingStore, route } from "./binding.ts"
import { checkpointOf } from "./conversation.ts"
import { createLock } from "./lock.ts"
import { createTurnRunner } from "./turn.ts"

function runResult(input: Partial<RunResult> = {}): RunResult {
  return { id: "run", status: "finished", ...input }
}

function fakeRun(input: {
  readonly messages?: Run["stream"]
  readonly result?: RunResult
  readonly cancel?: () => Promise<void>
} = {}): Run {
  return {
    id: "run",
    agentId: "agent",
    status: "running",
    supports(operation) {
      return operation === "stream" || operation === "wait" || operation === "cancel"
    },
    unsupportedReason() {
      return undefined
    },
    stream: input.messages ?? (async function* () {}),
    async conversation() {
      return []
    },
    async wait() {
      return input.result ?? runResult()
    },
    cancel: input.cancel ?? (async () => {}),
    onDidChangeStatus() {
      return () => {}
    },
  }
}

function runner(
  run: Run,
  receivedParams: Array<readonly ModelParameterValue[]> = [],
  receivedMessages: Array<string | SDKUserMessage> = [],
  receivedSendOptions: SendOptions[] = [],
  bindings = createBindingStore(),
  receivedAgentOptions: Array<unknown> = [],
) {
  return createTurnRunner({
    link: {
      async resolve() {
        return asApiKey("key")
      },
      register() {},
      async restore() {},
      reject() {},
      onLinked() {
        return () => {}
      },
    },
    models: () => SEED_MODELS,
    bindings,
    clock: () => 1,
    lock: createLock(),
    async openAgent(input) {
      receivedParams.push(input.params ?? [])
      receivedAgentOptions.push(input.agentOptions)
      return {
        id: asAgentID("agent-id"),
        async send(message, options) {
          receivedMessages.push(message)
          if (options !== undefined) receivedSendOptions.push(options)
          return run
        },
        async dispose() {},
      }
    },
  })
}

async function eventsFrom(run: ReturnType<typeof runner>, signal?: AbortSignal) {
  return Array.fromAsync(
    run({
      modelID: asCatalogModelID("composer-2.5"),
      scope: undefined,
      conversation: { system: [], turns: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] },
      params: [{ id: "thinking", value: "high" }],
      ...(signal === undefined ? {} : { signal }),
    }),
  )
}

describe("runTurn", () => {
  test("continues one Cursor run after OpenCode executes a bridged tool", async () => {
    const scope = { sessionID: asSessionID("ses_tools"), cwd: "/repo" }
    let sends = 0
    let opens = 0
    let disposals = 0
    const run = fakeRun({
      messages: async function* () {},
    })
    const executeTool: { current?: () => Promise<unknown> } = {}
    const bridge = createTurnRunner({
      link: {
        async resolve() {
          return asApiKey("key")
        },
        register() {},
        async restore() {},
        reject() {},
        onLinked() {
          return () => {}
        },
      },
      models: () => SEED_MODELS,
      bindings: createBindingStore(),
      clock: () => 1,
      lock: createLock(),
      async openAgent() {
        opens += 1
        return {
          id: asAgentID("agent-id"),
          async send(_message, options) {
            sends += 1
            const tool = options?.local?.customTools?.opencode__docs_search
            executeTool.current = async () => tool?.execute({ query: "Cursor" }, { toolCallId: "cursor-call" })
            return {
              ...run,
              stream: async function* () {
                const result = await executeTool.current?.()
                yield {
                  type: "assistant" as const,
                  agent_id: "agent",
                  run_id: "run",
                  message: {
                    role: "assistant" as const,
                    content: [{ type: "text" as const, text: `Found: ${JSON.stringify(result)}` }],
                  },
                }
              },
            }
          },
          async dispose() {
            disposals += 1
          },
        }
      },
    })
    const tools = [
      {
        name: "docs_search",
        description: "Search the documentation",
        inputSchema: { type: "object" },
      },
    ]
    const firstConversation = {
      system: [],
      turns: [{ role: "user" as const, parts: [{ type: "text" as const, text: "search docs" }] }],
    }

    const first = await Array.fromAsync(
      bridge({ modelID: asCatalogModelID("composer-2.5"), scope, conversation: firstConversation, tools }),
    )
    const toolRequest = first.find((event) => event.type === "tool-request")
    expect(toolRequest).toMatchObject({ name: "docs_search", input: { query: "Cursor" } })
    if (toolRequest?.type !== "tool-request") throw new Error("Expected a bridged tool request")
    expect(first).toContainEqual({ type: "done", reason: "tool-calls" })
    expect(disposals).toBe(0)

    const second = await Array.fromAsync(
      bridge({
        modelID: asCatalogModelID("composer-2.5"),
        scope,
        tools,
        conversation: {
          ...firstConversation,
          turns: [
            ...firstConversation.turns,
            {
              role: "assistant",
              parts: [{ type: "tool-call", id: toolRequest.id, name: "docs_search", input: '{"query":"Cursor"}' }],
            },
            {
              role: "tool",
              parts: [
                {
                  type: "tool-result",
                  id: toolRequest.id,
                  name: "docs_search",
                  output: [{ type: "text", text: "Cursor documentation" }],
                  isError: false,
                },
              ],
            },
          ],
        },
      }),
    )

    expect(second).toContainEqual({
      type: "text",
      delta: 'Found: {"content":[{"type":"text","text":"Cursor documentation"}]}',
    })
    expect(second).toContainEqual({ type: "done", reason: "stop", metadata: expect.any(Object) })
    expect({ opens, sends, disposals }).toEqual({ opens: 1, sends: 1, disposals: 1 })
  })

  test("uses RunResult usage when the stream has no usage message", async () => {
    const events = await eventsFrom(
      runner(
        fakeRun({
          result: runResult({
            usage: {
              inputTokens: 100,
              outputTokens: 40,
              cacheReadTokens: 20,
              cacheWriteTokens: 10,
              totalTokens: 140,
              reasoningTokens: 15,
            },
          }),
        }),
      ),
    )
    expect(events).toContainEqual({
      type: "usage",
      input: 100,
      output: 40,
      cacheRead: 20,
      cacheWrite: 10,
      reasoning: 15,
      total: 140,
    })
  })

  test("failed runs emit no successful finish", async () => {
    const events = await eventsFrom(
      runner(fakeRun({ result: runResult({ status: "error", error: { message: "backend failed" } }) })),
    )
    expect(events).toContainEqual({ type: "failed", error: { kind: "agent-run-failed", detail: "backend failed" } })
    expect(events.some((event) => event.type === "done")).toBe(false)
  })

  test("cancels a quiet run immediately and only once", async () => {
    const controller = new AbortController()
    let release: () => void = () => {}
    const quiet = new Promise<void>((resolve) => {
      release = resolve
    })
    let startedResolve: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve
    })
    let cancellations = 0
    const run = fakeRun({
      messages: async function* () {
        startedResolve()
        await quiet
      },
      result: runResult({ status: "cancelled" }),
      async cancel() {
        cancellations += 1
        release()
      },
    })

    const pending = eventsFrom(runner(run), controller.signal)
    await started
    controller.abort()
    controller.abort()

    expect(await pending).toContainEqual({ type: "failed", error: { kind: "cancelled" } })
    expect(cancellations).toBe(1)
  })

  test("does not start a run for a request that is already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const opened: Array<unknown> = []
    const events = await eventsFrom(
      runner(fakeRun(), [], [], [], createBindingStore(), opened),
      controller.signal,
    )
    expect(events).toEqual([{ type: "failed", error: { kind: "cancelled" } }])
    expect(opened).toEqual([])
  })

  test("rejects OpenCode tools without a session scope", async () => {
    const opened: Array<unknown> = []
    const events = await Array.fromAsync(
      runner(fakeRun(), [], [], [], createBindingStore(), opened)({
        modelID: asCatalogModelID("composer-2.5"),
        scope: undefined,
        conversation: { system: [], turns: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] },
        tools: [{ name: "docs_search", inputSchema: { type: "object" } }],
      }),
    )

    expect(events).toEqual([{ type: "failed", error: { kind: "unsupported-request", reason: "tools-requested" } }])
    expect(opened).toEqual([])
  })

  test("forwards selected model parameters", async () => {
    const received: Array<readonly ModelParameterValue[]> = []
    await eventsFrom(runner(fakeRun(), received))
    expect(received).toEqual([[{ id: "thinking", value: "high" }]])
  })

  test("sends image-only user turns to Cursor", async () => {
    const received: Array<string | SDKUserMessage> = []
    const run = runner(fakeRun(), [], received)
    await Array.fromAsync(
      run({
        modelID: asCatalogModelID("composer-2.5"),
        scope: undefined,
        conversation: {
          system: [],
          turns: [
            {
              role: "user",
              parts: [{ type: "image", image: { data: "aGVsbG8=", mimeType: "image/png" } }],
            },
          ],
        },
      }),
    )
    expect(received).toEqual([
      { text: "User: [Image 1: image/png]", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] },
    ])
  })

  test("forwards Cursor mode and emits requested raw messages", async () => {
    const receivedOptions: SendOptions[] = []
    const message = {
      type: "thinking" as const,
      agent_id: "agent",
      run_id: "run",
      text: "thinking",
    }
    const events = await Array.fromAsync(
      runner(
        fakeRun({ messages: async function* () { yield message } }),
        [],
        [],
        receivedOptions,
      )({
        modelID: asCatalogModelID("composer-2.5"),
        scope: undefined,
        conversation: { system: [], turns: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] },
        mode: "plan",
        includeRawChunks: true,
      }),
    )
    expect(receivedOptions).toEqual([{ mode: "plan" }])
    expect(events).toContainEqual({ type: "raw", value: message })
  })

  test("forwards local Cursor agent options", async () => {
    const receivedAgentOptions: Array<unknown> = []
    await Array.fromAsync(
      runner(fakeRun(), [], [], [], createBindingStore(), receivedAgentOptions)({
        modelID: asCatalogModelID("composer-2.5"),
        scope: undefined,
        conversation: { system: [], turns: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] },
        agentOptions: {
          tools: ["read"],
          sandboxOptions: { enabled: true },
          autoReview: true,
          settingSources: ["project"],
        },
      }),
    )
    expect(receivedAgentOptions).toEqual([
      {
        tools: ["read"],
        sandboxOptions: { enabled: true },
        autoReview: true,
        settingSources: ["project"],
      },
    ])
  })

  test("sends only the new user turn when it resumes an agent", async () => {
    const bindings = createBindingStore()
    const scope = { sessionID: asSessionID("ses_resume"), cwd: "/repo" }
    const previous = {
      system: ["be brief"],
      turns: [
        { role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] },
        { role: "assistant" as const, parts: [{ type: "text" as const, text: "answer" }] },
      ],
    }
    bindings.put({
      sessionID: scope.sessionID,
      agentID: asAgentID("agent-id"),
      modelID: asCatalogModelID("composer-2.5"),
      cwd: scope.cwd,
      checkpoint: checkpointOf(previous),
      params: undefined,
      mode: undefined,
      agentOptions: undefined,
      lastUsedAt: asEpochMs(1),
    })
    const received: Array<string | SDKUserMessage> = []
    await Array.fromAsync(
      runner(fakeRun(), [], received, [], bindings)({
        modelID: asCatalogModelID("composer-2.5"),
        scope,
        conversation: {
          ...previous,
          turns: [...previous.turns, { role: "user", parts: [{ type: "text", text: "next" }] }],
        },
      }),
    )
    expect(received).toEqual(["User: next"])
  })

  test("the saved checkpoint includes the generated assistant response", async () => {
    const bindings = createBindingStore()
    const scope = { sessionID: asSessionID("ses_1"), cwd: "/repo" }
    const message = {
      type: "assistant" as const,
      agent_id: "agent",
      run_id: "run",
      message: { role: "assistant" as const, content: [{ type: "text" as const, text: "answer" }] },
    }
    const run = runner(fakeRun({ messages: async function* () { yield message } }), [], [], [], bindings)
    await Array.fromAsync(
      run({
        modelID: asCatalogModelID("composer-2.5"),
        scope,
        conversation: { system: [], turns: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] },
      }),
    )
    const saved = bindings.get(scope.sessionID)
    expect(saved).toBeDefined()
    expect(
      route({
        scope,
        binding: saved,
        modelID: asCatalogModelID("composer-2.5"),
        conversation: {
          system: [],
          turns: [
            { role: "user", parts: [{ type: "text", text: "hello" }] },
            { role: "assistant", parts: [{ type: "text", text: "answer" }] },
            { role: "user", parts: [{ type: "text", text: "next" }] },
          ],
        },
        params: undefined,
        mode: undefined,
        agentOptions: undefined,
      }),
    ).toBe("RESUME")
    expect(
      route({
        scope,
        binding: saved,
        modelID: asCatalogModelID("composer-2.5"),
        conversation: {
          system: [],
          turns: [
            { role: "user", parts: [{ type: "text", text: "hello" }] },
            { role: "assistant", parts: [{ type: "text", text: "changed" }] },
            { role: "user", parts: [{ type: "text", text: "next" }] },
          ],
        },
        params: undefined,
        mode: undefined,
        agentOptions: undefined,
      }),
    ).toBe("FRESH")
  })
})
