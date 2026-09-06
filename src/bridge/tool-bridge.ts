import type { SDKCustomTool, SDKCustomToolResult, SDKJsonValue } from "@cursor/sdk"
import { randomUUID } from "node:crypto"
import type { UserPart } from "./conversation.ts"

const TOOL_PREFIX = "opencode__"
const CODE_MODE_DISCOVERY = [
  "OpenCode MCP tools are available only inside this Code Mode tool.",
  "Do not search for them with Cursor GetDynamicTools.",
  'To find an MCP tool, call this tool with code such as `return await tools.$codemode.search({ query: "posthog" })`.',
].join("\n")

export interface OpenCodeToolRequest {
  readonly id: string
  readonly name: string
  readonly input: Record<string, SDKJsonValue>
}

export interface OpenCodeToolDefinition {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, SDKJsonValue>
}

export interface OpenCodeToolResult {
  readonly id: string
  readonly output: readonly UserPart[]
  readonly isError: boolean
}

export interface OpenCodeToolBridge {
  readonly customTools: Record<string, SDKCustomTool>
  waitForCalls(): Promise<void>
  takeCalls(): readonly OpenCodeToolRequest[]
  resolve(results: readonly OpenCodeToolResult[]): number
  isCursorCall(id: string): boolean
  cancel(reason: string): void
}

interface PendingCall {
  readonly request: OpenCodeToolRequest
  readonly resolve: (result: SDKCustomToolResult) => void
  readonly reject: (error: Error) => void
}

export function createOpenCodeToolBridge(
  tools: readonly OpenCodeToolDefinition[],
  bridgeID: string = randomUUID(),
): OpenCodeToolBridge {
  const queued: OpenCodeToolRequest[] = []
  const pending = new Map<string, PendingCall>()
  const cursorCallIDs = new Set<string>()
  let sequence = 0
  let waiter: Promise<void> | undefined
  let wake: (() => void) | undefined

  const entries = tools
    .map<[string, SDKCustomTool]>((tool) => [
      `${TOOL_PREFIX}${tool.name}`,
      {
        ...(tool.description === undefined && tool.name !== "execute"
          ? {}
          : {
              description:
                tool.name === "execute"
                  ? [CODE_MODE_DISCOVERY, tool.description].filter((item) => item !== undefined).join("\n\n")
                  : tool.description,
            }),
        inputSchema: tool.inputSchema,
        execute(args, context) {
          sequence += 1
          if (context.toolCallId !== undefined) cursorCallIDs.add(context.toolCallId)
          const id = `${bridgeID}-${sequence}`
          const request = { id, name: tool.name, input: args }
          queued.push(request)
          const waiting = new Promise<SDKCustomToolResult>((resolve, reject) => {
            pending.set(id, { request, resolve, reject })
          })
          wake?.()
          wake = undefined
          waiter = undefined
          return waiting
        },
      },
    ])

  return {
    customTools: Object.fromEntries(entries),
    waitForCalls() {
      if (queued.length > 0) return Promise.resolve()
      if (waiter !== undefined) return waiter
      waiter = new Promise<void>((resolve) => {
        wake = resolve
      })
      return waiter
    },
    takeCalls() {
      return queued.splice(0)
    },
    resolve(results) {
      let resolved = 0
      for (const result of results) {
        const call = pending.get(result.id)
        if (call === undefined) continue
        pending.delete(result.id)
        resolved += 1
        call.resolve({
          content: result.output.map((part) => {
            if (part.type === "text") return { type: "text", text: part.text }
            return { type: "image", data: part.image.data, mimeType: part.image.mimeType }
          }),
          ...(result.isError ? { isError: true } : {}),
        })
      }
      return resolved
    },
    isCursorCall(id) {
      return cursorCallIDs.has(id)
    },
    cancel(reason) {
      const error = new Error(reason)
      for (const call of pending.values()) call.reject(error)
      pending.clear()
      queued.splice(0)
      wake?.()
      wake = undefined
      waiter = undefined
    },
  }
}
