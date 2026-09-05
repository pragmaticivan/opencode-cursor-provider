import {
  Agent,
  AgentNotFoundError,
  type AgentOptions,
  type ModelParameterValue,
  type Run,
  type SDKUserMessage,
  type SendOptions,
} from "@cursor/sdk"
import { asAgentID, type CursorAgentID, type CursorApiKey } from "../ids.ts"
import type { CursorAgentOptions } from "../model/provider-options.ts"

export interface CursorAgentSession {
  readonly id: CursorAgentID
  send(prompt: string | SDKUserMessage, options?: SendOptions): Promise<Run>
  dispose(): Promise<void>
}

export async function openCursorAgent(input: {
  apiKey: CursorApiKey
  wireID: string
  params: readonly ModelParameterValue[] | undefined
  cwd: string
  resume: CursorAgentID | undefined
  agentOptions: CursorAgentOptions | undefined
}): Promise<CursorAgentSession> {
  const model = {
    id: input.wireID,
    ...(input.params === undefined ? {} : { params: input.params.map((param) => ({ ...param })) }),
  }
  const options: AgentOptions = {
    apiKey: input.apiKey,
    model,
    ...(input.agentOptions?.tools === undefined ? {} : { tools: [...input.agentOptions.tools] }),
    ...(input.agentOptions?.disallowedTools === undefined
      ? {}
      : { disallowedTools: [...input.agentOptions.disallowedTools] }),
    local: {
      cwd: input.cwd,
      ...(input.agentOptions?.autoReview === undefined ? {} : { autoReview: input.agentOptions.autoReview }),
      ...(input.agentOptions?.settingSources === undefined
        ? {}
        : { settingSources: [...input.agentOptions.settingSources] }),
      ...(input.agentOptions?.sandboxOptions === undefined
        ? {}
        : { sandboxOptions: { ...input.agentOptions.sandboxOptions } }),
    },
  }
  const agent =
    input.resume === undefined ? await Agent.create(options) : await Agent.resume(input.resume, options)

  return {
    id: asAgentID(agent.agentId),
    send(prompt, sendOptions) {
      return agent.send(prompt, sendOptions)
    },
    dispose() {
      return agent[Symbol.asyncDispose]()
    },
  }
}

export function isAgentLost(error: unknown): boolean {
  return error instanceof AgentNotFoundError
}
