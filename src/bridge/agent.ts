import { Agent, AgentNotFoundError, type ModelParameterValue, type Run } from "@cursor/sdk"
import { asAgentID, type CursorAgentID, type CursorApiKey } from "../ids.ts"

export interface CursorAgentSession {
  readonly id: CursorAgentID
  send(prompt: string): Promise<Run>
  dispose(): Promise<void>
}

export async function openCursorAgent(input: {
  apiKey: CursorApiKey
  wireID: string
  params: readonly ModelParameterValue[] | undefined
  cwd: string
  resume: CursorAgentID | undefined
}): Promise<CursorAgentSession> {
  const model = {
    id: input.wireID,
    ...(input.params === undefined ? {} : { params: input.params.map((param) => ({ ...param })) }),
  }
  const options = {
    apiKey: input.apiKey,
    model,
    local: { cwd: input.cwd },
  }
  const agent =
    input.resume === undefined ? await Agent.create(options) : await Agent.resume(input.resume, options)

  return {
    id: asAgentID(agent.agentId),
    send(prompt) {
      return agent.send(prompt)
    },
    dispose() {
      return agent[Symbol.asyncDispose]()
    },
  }
}

export function isAgentLost(error: unknown): boolean {
  return error instanceof AgentNotFoundError
}
