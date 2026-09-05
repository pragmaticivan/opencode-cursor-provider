import type { ModelParameterValue, Run, RunResult } from "@cursor/sdk"
import { describe, expect, test } from "bun:test"
import { SEED_MODELS } from "../catalog/catalog.ts"
import { asAgentID, asApiKey, asCatalogModelID } from "../ids.ts"
import { createBindingStore } from "./binding.ts"
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

function runner(run: Run, receivedParams: Array<readonly ModelParameterValue[]> = []) {
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
    bindings: createBindingStore(),
    clock: () => 1,
    lock: createLock(),
    async openAgent(input) {
      receivedParams.push(input.params ?? [])
      return {
        id: asAgentID("agent-id"),
        async send() {
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
      conversation: { system: [], turns: [{ role: "user", text: "hello" }] },
      params: [{ id: "thinking", value: "high" }],
      ...(signal === undefined ? {} : { signal }),
    }),
  )
}

describe("runTurn", () => {
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
    })
  })

  test("failed runs emit no successful finish", async () => {
    const events = await eventsFrom(
      runner(fakeRun({ result: runResult({ status: "error", error: { message: "backend failed" } }) })),
    )
    expect(events).toEqual([{ type: "failed", error: { kind: "agent-run-failed", detail: "backend failed" } }])
  })

  test("cancels a quiet run immediately and only once", async () => {
    const controller = new AbortController()
    let release: () => void = () => {}
    const quiet = new Promise<void>((resolve) => {
      release = resolve
    })
    let cancellations = 0
    const run = fakeRun({
      messages: async function* () {
        await quiet
      },
      result: runResult({ status: "cancelled" }),
      async cancel() {
        cancellations += 1
        release()
      },
    })

    const pending = eventsFrom(runner(run), controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    controller.abort()

    expect(await pending).toEqual([{ type: "failed", error: { kind: "cancelled" } }])
    expect(cancellations).toBe(1)
  })

  test("forwards selected model parameters", async () => {
    const received: Array<readonly ModelParameterValue[]> = []
    await eventsFrom(runner(fakeRun(), received))
    expect(received).toEqual([[{ id: "thinking", value: "high" }]])
  })
})
