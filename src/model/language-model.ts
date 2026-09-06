import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type { ModelParameterValue } from "@cursor/sdk"
import type { SessionAgentBridge } from "../bridge/bridge.ts"
import type { CatalogModelID } from "../ids.ts"
import { parseCall, warningsOf } from "./request.ts"
import { collectGenerate, coupleAbort, toStreamParts } from "./response.ts"

export function toLanguageModel(input: {
  bridge: SessionAgentBridge
  modelID: CatalogModelID
  wireID: string
  params: readonly ModelParameterValue[] | undefined
}): LanguageModelV3 {
  const stream = (options: LanguageModelV3CallOptions) => {
    const coupled = coupleAbort(options.abortSignal)
    return toStreamParts(
      input.bridge.turn(parseCall({ ...options, abortSignal: coupled.signal }, input.modelID, input.params)),
      coupled.abort,
      warningsOf(options),
    )
  }

  return {
    specificationVersion: "v3",
    provider: "cursor",
    modelId: input.wireID,
    supportedUrls: {},
    doGenerate: async (options) => collectGenerate(stream(options)),
    doStream: async (options) => ({ stream: stream(options) }),
  }
}
