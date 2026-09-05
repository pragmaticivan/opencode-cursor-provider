import { canonicalJson, type AssistantPart } from "./conversation.ts"
import type { TurnEvent } from "./translate.ts"

export interface ResponseJournal {
  accept(event: TurnEvent): TurnEvent | undefined
  parts(): readonly AssistantPart[]
}

export function createResponseJournal(): ResponseJournal {
  const parts: AssistantPart[] = []
  const toolCalls = new Set<string>()
  const toolResults = new Set<string>()

  return {
    accept(event) {
      if (event.type === "text" || event.type === "reasoning") {
        const previous = parts.at(-1)
        if (previous?.type === event.type) {
          parts.splice(-1, 1, { type: event.type, text: previous.text + event.delta })
        } else {
          parts.push({ type: event.type, text: event.delta })
        }
        return event
      }
      if (event.type === "tool-call") {
        if (toolCalls.has(event.id)) return undefined
        toolCalls.add(event.id)
        parts.push({ type: "tool-call", id: event.id, name: event.name, input: canonicalJson(event.input) })
        return event
      }
      if (event.type === "tool-result") {
        if (toolResults.has(event.id)) return undefined
        toolResults.add(event.id)
        parts.push({
          type: "tool-result",
          id: event.id,
          name: event.name,
          output: [
            {
              type: "text",
              text: typeof event.result === "string" ? event.result : canonicalJson(event.result),
            },
          ],
          isError: event.isError,
        })
        return event
      }
      return event
    },
    parts() {
      return parts
    },
  }
}
