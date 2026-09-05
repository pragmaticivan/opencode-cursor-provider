# Cursor provider OpenCode V2 compatibility notes

## Scope

These notes record the OpenCode V2 compatibility work for the Cursor provider.
The comparison uses the AI SDK V3 contract and common native provider behavior as the baseline.

The goal is maximum honest compatibility. The provider supports each representable feature.
The provider rejects semantic requirements that Cursor cannot meet. It warns when Cursor ignores an optional control.

## Project rules

- Use the official `@cursor/sdk` types and operations.
- Keep Cursor tools separate from OpenCode tools.
- Mark Cursor tool calls as provider-executed.
- Do not convert tool activity into reasoning text.
- Do not report success after an error or a cancellation.
- Connect each `AbortSignal` to `Run.cancel()`.
- Keep one async generator in `runTurn()`.
- Use one keyed lock for each OpenCode session.
- Preserve Cursor model parameter values without interpretation.
- Reject unsupported input instead of discarding it.
- Parse external data at the module boundary.
- Keep strict TypeScript without unchecked type escapes.
- Do not use an authenticated Cursor request without approval.

## Architecture decisions

### Use fixed-size conversation fingerprints

One OpenCode session binds to one Cursor agent. The binding stores SHA-256 fingerprints instead of full prompt copies.

The route starts a fresh Cursor agent after one of these changes:

- The model ID changes.
- The Cursor model parameters change.
- The working directory changes.
- The Cursor mode changes.
- The system instructions change.
- The saved conversation prefix changes.

The route resumes only for one new user turn after the exact saved prefix.
This rule prevents the resume path from dropping new assistant or tool history.

### Include generated assistant output

The saved checkpoint includes the assistant response from the completed Cursor run.
The response includes text, reasoning, tool calls, and tool results.

Without this output, an edited assistant branch can resume an agent that remembers a different answer.

### Keep checkpoint data structured

A text-only checkpoint permits semantic collisions. Visible text can contain the same markers as reasoning or tool history.

The current refactor changes conversation turns to structured parts. The fingerprint then includes the role and the part type.
The renderer adds text markers only when it sends full history to a fresh Cursor agent.

### Use canonical JSON

Tool inputs and tool results need stable JSON text. Object key insertion order must not change the checkpoint.

The canonical JSON function sorts object keys recursively. It keeps array order.
The implementation must preserve an own `__proto__` key without changing an object prototype.

### Do not replace the Cursor system prompt

`AgentOptions.systemPrompt` replaces the complete Cursor coding-agent harness. It does not add OpenCode instructions to that harness.

The Cursor server also gates this option. The provider sends system instructions in the conversation transcript instead.

### Keep tool ownership separate

Cursor owns its built-in tools, approvals, and workspace changes. OpenCode shows this activity as provider-executed tool activity.

The provider exposes OpenCode tools as run-scoped Cursor custom tools with an `opencode__` prefix. OpenCode executes each bridged call through its normal tool pipeline.

### Reject URL images

The AI SDK can provide image URLs. The local Cursor agent does not accept URL images reliably.

The provider advertises no supported URL patterns. It rejects URL images instead of downloading or discarding them.

## Implemented compatibility work

### Input

- Accept text input.
- Accept local images as base64 strings or `Uint8Array` values.
- Convert byte images to base64 for `SDKUserMessage`.
- Keep each image with its source user turn.
- Preserve the order of text and image parts in the structured conversation model.
- Reject image URLs.
- Reject wildcard `image/*` media types.
- Reject non-image files.
- Reject assistant file parts.
- Preserve assistant text, reasoning, tool calls, and tool results for a fresh agent.
- Preserve tool-role results and tool approval history for a fresh agent.

### Request controls

- Forward Cursor model parameter values without interpretation.
- Support `providerOptions.cursor.mode` with `"agent"` and `"plan"`.
- Support Cursor built-in tool allowlists and denylists.
- Support Cursor sandbox selection and automatic review.
- Support Cursor settings layers.
- Reject invalid Cursor modes.
- Reject structured output requests.
- Bridge OpenCode function tools through run-scoped Cursor custom tools.
- Reject an explicit nonautomatic tool choice.
- Warn for standard generation controls that Cursor ignores.
- Warn for nonempty request headers that Cursor ignores.
- Warn for unknown provider options.
- Warn for message-level and content-level provider options.

### Output

- Preserve text, reasoning, and tool blocks in stream order.
- Mark Cursor tool calls as provider-executed and dynamic.
- Deduplicate repeated tool call updates.
- Deduplicate repeated completed tool results.
- Use a new block ID when text or reasoning resumes after another block.
- Return raw Cursor chunks only when `includeRawChunks` is true.
- Return the response ID, timestamp, and model ID.
- Return the run ID, request ID, duration, and model ID when available.
- Preserve input, output, cache-read, cache-write, reasoning, and total token usage.
- Use streamed usage before `RunResult.usage`.
- Use `RunResult.usage` only when the stream has no usage event.
- Stop without a finish event after an error or a cancellation.

### Session behavior

- Bind one OpenCode session to one Cursor agent.
- Use a keyed lock for each OpenCode session.
- Keep a Cursor run active while OpenCode executes a bridged tool.
- Validate the tool-result continuation against the exact conversation checkpoint.
- Start one-shot calls without a session binding.
- Send only the new user turn to a resumed Cursor agent.
- Replay the full structured transcript to a fresh Cursor agent.
- Retry once with a fresh agent when Cursor loses a resumed agent.
- Connect an abort request to `Run.cancel()`.
- Remove the abort listener after the run.

## Feature-gap matrix

The table lists AI SDK V3 features that native providers can expose but this provider does not fully expose.
Support differs between native providers, so the table does not claim that every provider has every feature.

This audit uses the public interface of `@cursor/sdk` 1.0.31. Internal protocol fields do not count as supported operations.

| Flag | Feature in the comparison baseline | Cursor provider behavior | Cursor SDK 1.0.31 fact | Evidence |
| --- | --- | --- | --- | --- |
| 🚫 | `maxOutputTokens` | Warns and ignores the value. | `AgentOptions` and `SendOptions` have no output-token control. | `options.d.ts`, `agent.d.ts` |
| 🚫 | `temperature` | Warns and ignores the value. | The public agent options have no temperature control. An internal protocol occurrence does not make a public SDK operation. | `options.d.ts`, `agent.d.ts` |
| 🚫 | `topP` | Warns and ignores the value. | The public agent options have no nucleus sampling control. | `options.d.ts`, `agent.d.ts` |
| 🚫 | `topK` | Warns and ignores the value. | The public agent options have no top-K control. | `options.d.ts`, `agent.d.ts` |
| 🚫 | `stopSequences` | Warns and ignores nonempty values. | The public agent options have no stop-sequence control. | `options.d.ts`, `agent.d.ts` |
| 🚫 | `presencePenalty` | Warns and ignores the value. | The public agent options have no presence penalty. | `options.d.ts`, `agent.d.ts` |
| 🚫 | `frequencyPenalty` | Warns and ignores the value. | The public agent options have no frequency penalty. | `options.d.ts`, `agent.d.ts` |
| 🚫 | `seed` | Warns and ignores the value. | The public agent options have no sampling seed. | `options.d.ts`, `agent.d.ts` |
| 🚫 | Structured JSON output | Rejects the request. | The public agent API has no constrained response format. | `SDKAgent.send()`, `SendOptions`, `RunResult` |
| 🚫 | JSON schema output | Rejects the request. | The public agent API cannot apply a schema to the assistant response. Custom-tool schemas apply only to tools. | `SDKCustomTool`, `SendOptions` |
| 🚫 | Non-image file input | Rejects the file. | `SDKUserMessage` accepts only `text` and `images`. | `options.d.ts:17` |
| ☁️ | Image URL input | Rejects the URL. | `SDKImage` supports URLs, but the local runtime throws. URL images are cloud-only. | `options.d.ts:9`, local runtime error text |
| 🚫 | Assistant file history | Rejects the file part. | `Agent.send()` accepts one user message. The SDK has no public prior-history import operation. | `SDKAgent.send()`, `Run.conversation()` |
| ☁️ | Generated file or artifact output | Emits no AI SDK file part. | The SDK can list and download cloud artifacts. Local agents return no artifacts and reject downloads. | `SDKAgent.listArtifacts()`, `downloadArtifact()` |
| 🚫 | First-class cited source output | Emits no AI SDK source part. | `SDKMessage` and `ConversationStep` have no citation or source variant. Tool results can contain URLs, but they are not source events. | `messages.d.ts`, `conversation-types.d.ts` |
| 🚫 | Tool approval request output | Emits no AI SDK approval request part. | The public stream and delta unions have no approval-request variant. Cursor owns its approval flow. | `SDKMessage`, `InteractionUpdate` |
| 🚫 | Exact AI SDK finish reasons | Reports `stop` for a successful run. | Cursor reports finished, error, or cancelled. It does not report length or content-filter reasons. | `RunResultStatus`, `SDKStatusMessage` |
| 🚫 | Per-call HTTP headers | Warns and ignores nonempty headers. | `Agent.send()` has no generic header option. MCP server headers are unrelated. | `SendOptions`, `McpServerConfig` |
| 🚫 | Model context limits | Uses the OpenCode default. | `ModelListItem` has no context-limit field. | `options.d.ts:124` |
| 🚫 | Model output limits | Uses the OpenCode default. | `ModelListItem` has no output-limit field. | `options.d.ts:124` |
| 🚫 | Catalog input and output prices | Uses the OpenCode default. | `ModelListItem` has no unit-price fields. | `options.d.ts:124` |
| 🧰 | Billed run cost | Does not expose the cost. | `SDKAgent.getUsage()` returns total and per-run cost after billing data becomes available. | `agent.d.ts:25`, `usage-types.d.ts` |
| 🧰 | Fine-grained text and reasoning deltas | Uses `Run.stream()` messages. | `SendOptions.onDelta` exposes text and reasoning deltas. | `SendOptions.onDelta`, `InteractionUpdate` |
| 🧰 | Tool input progress | Emits complete provider-executed tool calls. | `onDelta` exposes partial tool calls and tool-call delta updates. The provider does not consume them. | `PartialToolCallUpdate`, `ToolCallDeltaUpdate` |
| 🧰 | Structured run history | Builds its own checkpoint transcript. | `Run.conversation()` returns structured turns after a run. It does not import prior turns. | `Run.conversation()`, `ConversationTurn` |
| ✅ | OpenCode function tools | Exposes prefixed tools as run-scoped callbacks. OpenCode executes each returned tool call. | The SDK supports per-send local callback tools. | `LocalSendOptions.customTools` |
| 🧰 | OpenCode provider tools | Rejects nonempty tool lists. | The SDK supports Cursor tools and MCP tools, not OpenCode provider-tool semantics. | `AgentOptions.tools`, `mcpServers` |
| ⚠️ | Explicit tool choice | Rejects nonautomatic choices. | Cursor can restrict a tool set, but it cannot express every AI SDK tool-choice mode. | `AgentOptions.tools`, `disallowedTools` |
| ✅ | Cursor built-in tool controls | Supports `cursor.tools` and `cursor.disallowedTools`. | Local agents support tool allowlists and denylists. | `AgentOptions.tools`, `disallowedTools` |
| ✅ | Cursor custom tools | Uses per-send callbacks internally to bridge OpenCode tools. | Local agents support agent-level and per-send callback tools. | `LocalAgentOptions.customTools`, `LocalSendOptions.customTools` |
| 🧰 | Cursor MCP server configuration | Does not map request options to MCP servers. | The SDK supports agent-level and per-send MCP server definitions. | `AgentOptions.mcpServers`, `SendOptions.mcpServers` |
| ✅ | Cursor sandbox selection | Supports `cursor.sandboxOptions`. | Local agents expose `sandboxOptions`. | `LocalAgentOptions.sandboxOptions` |
| ✅ | Cursor automatic review | Supports `cursor.autoReview`. | Local agents expose `autoReview`. | `LocalAgentOptions.autoReview` |
| 🧰 | Multiple workspace roots | Uses one OpenCode working directory. | Local agents expose `dirs` in addition to the primary `cwd`. | `LocalAgentOptions.dirs` |
| ✅ | Cursor settings layers | Supports `cursor.settingSources`. | Local agents expose `settingSources`. | `LocalAgentOptions.settingSources` |
| 🧰 | Run steering | Does not expose steering. | Supported runs can accept `Run.steer(text)`. AI SDK V3 has no direct standard field for it. | `run.d.ts:61` |
| 🧰 | Per-send model selection | Selects the model when it opens the agent. | `SendOptions.model` can change the model for a send. | `agent.d.ts:37` |
| ⚠️ | Full custom system prompt | Does not set the option. | The option exists, but it replaces the complete Cursor harness and needs gated server access. | `AgentOptions.systemPrompt` |
| ⚠️ | Structured prior conversation import | Replays prior history as one rendered user message. | The SDK exports structured history output but no public history input. | `Run.conversation()`, `SDKAgent.send()` |
| ⚠️ | Prompt-injection isolation for replayed tool output | Renders transcript data into one user message. | The SDK has no public structured-history import operation. | `SDKAgent.send()` |
| ⚠️ | Image validation and limits | Checks the media type but sets no count or byte limit. | The public image type gives no count or byte limit. | `SDKImage`, `SDKUserMessage` |
| ⚠️ | Git result metadata | Omits the Git data. | Cursor returns repository URLs and branch data in `RunResult.git`. | `run.d.ts:26` |
| ⚠️ | Raw Cursor chunks | Returns raw messages when requested. | Raw messages can include prompts, reasoning, and complete tool results. | `SDKMessage` |
| ⚠️ | Unknown Cursor provider options | Warns instead of forwarding them. | Only `cursor.mode` has a validated provider map. | `src/model/language-model.ts` |
| ⚠️ | Message and content provider options | Warns and ignores them. | Cursor has no matching per-message or per-part option fields. | `SDKUserMessage`, `SendOptions` |

Flag meanings:

- 🚫 means that the public Cursor SDK has no equivalent operation or field.
- ✅ means that the provider supports the SDK feature.
- ☁️ means that the public Cursor SDK supports the feature only for cloud agents.
- 🧰 means that the public Cursor SDK supports the feature, but this provider does not expose it.
- ⚠️ means that the available SDK feature is partial, unsafe as a direct map, or not equivalent.

### SDK audit corrections

The first matrix incorrectly marked generated files as absent from the complete SDK.
Cloud agents expose `listArtifacts()` and `downloadArtifact()`. The local runtime does not implement artifact downloads.

The first matrix also marked URL images as absent. `SDKImage` includes a URL variant for cloud agents.
The local runtime throws `URL images are only supported for cloud SDK agents`.

The first matrix said that Cursor had no tool input deltas. `SendOptions.onDelta` exposes partial tool calls and tool-call delta updates.
The provider uses `Run.stream()` and does not connect the delta callback.

The SDK exposes structured history through `Run.conversation()`. This method reads run history but does not import prior history.

The SDK exposes billed costs through `SDKAgent.getUsage()`. Cost is separate from `RunResult.usage` and can arrive after the run.

### Audit sources

- Installed package: `@cursor/sdk` 1.0.31.
- Public declarations: `node_modules/@cursor/sdk/dist/esm/*.d.ts`.
- Local runtime behavior: `node_modules/@cursor/sdk/dist/esm/index.js`.
- Cloud artifact behavior: `node_modules/@cursor/sdk/dist/esm/642.js`.
- Official reference: <https://cursor.com/docs/sdk/typescript>.

## Official `cursor/sdk-bridge` review

The `cursor/sdk-bridge` repository does not contain an OpenCode provider or an AI SDK adapter.
It publishes a language-neutral `sdk.v1` protobuf contract and a standalone local server.

The local server embeds `@cursor/sdk`. An adapter starts the server and calls it through Connect RPC over HTTP.
The repository contains one example Python adapter. It contains no TypeScript adapter because TypeScript can use `@cursor/sdk` directly.

The official README gives this instruction:

> Scripting agents from TypeScript or Python? Use the official SDKs. You do not need this repository.

The reviewed bridge tag is `v1.0.31`. Its manifest points to SDK version `1.0.31`.

### Bridge comparison

| Concern | Direct `@cursor/sdk` in this provider | Official `sdk-bridge` | Result |
| --- | --- | --- | --- |
| OpenCode AI SDK V3 interface | Implemented by this repository. | Not provided. | Keep this repository's language-model adapter. |
| TypeScript agent access | Calls `Agent.create()`, `Agent.resume()`, and `Agent.send()`. | Wraps the same TypeScript SDK in another process. | Keep direct SDK access. |
| Process lifecycle | Uses the current OpenCode process. | Needs spawn, handshake, shutdown, and crash cleanup. | The bridge adds work for TypeScript. |
| Transport | Uses typed TypeScript calls. | Needs Connect RPC, protobuf messages, bearer auth, and stream framing. | The bridge adds code without a compatibility gain. |
| Stream messages | Uses `Run.stream()`. | Relays the same `SDKMessage` values in a protobuf envelope. | The AI SDK mapping remains necessary. |
| Fine deltas | Can use `SendOptions.onDelta`. | Uses `enable_deltas` and stream envelopes. | Direct SDK access has the same underlying data. |
| Completed steps | Can use `SendOptions.onStep`. | Uses `enable_steps` and stream envelopes. | Direct SDK access has the same underlying data. |
| Structured run history | Uses `Run.conversation()`. | Uses `GetRunConversation`. | Neither interface imports an OpenCode transcript. |
| Artifacts | Exposes cloud artifacts through `SDKAgent`. | Exposes cloud artifacts through RPCs. | Local agents still have no artifacts. |
| Custom tools | Supports agent-level and per-send callbacks. | Supports adapter callbacks, but reserves per-send custom tools. | The direct SDK has the larger TypeScript surface. |
| Custom system prompt | Exposes `AgentOptions.systemPrompt`. | The reviewed proto does not expose this field. | The bridge does not add system prompt support. |
| Run steering | Exposes optional `Run.steer()`. | The reviewed service has no steer RPC. | The bridge has a smaller surface here. |
| Local billed usage | The TypeScript SDK documents local per-turn usage. | The bridge documents `GetUsage` as cloud-only. | The bridge can lose local usage access. |
| Session branching | OpenCode sessions can rewind or branch. | The bridge resumes Cursor agents by ID. | This provider must still detect OpenCode branch changes. |

### Code that remains necessary

The following code is not duplicated by `cursor/sdk-bridge`:

- The AI SDK V3 `LanguageModelV3` implementation.
- The mapping from AI SDK prompts to Cursor user messages.
- The mapping from Cursor events to AI SDK stream parts.
- The provider-executed tool markers.
- The OpenCode session marker parser.
- The OpenCode session lock.
- The branch, rewind, model, directory, parameter, and mode routing rules.
- The warning and rejection rules for unsupported AI SDK options.
- The OpenCode model catalog mapping.
- The Cursor authentication integration for OpenCode.

### Code that needs another simplicity review

The official bridge does not remove the need for conversation fingerprints. Cursor knows its own history but does not know the active OpenCode branch.

`Run.conversation()` can provide structured Cursor history after a run. It does not provide an OpenCode history import operation.
Using it for fingerprints would need another normalization layer between Cursor tool types and AI SDK content parts.

`SendOptions.onDelta` can provide better tool progress. Adding it needs an event queue that merges callbacks with `Run.stream()`.
Do not add that queue unless OpenCode needs partial tool input.

The current direct wrapper in `src/bridge/agent.ts` is small. Replacing it with the bridge protocol would increase code and runtime risk.

### Bridge verdict

Do not adopt `cursor/sdk-bridge` for this TypeScript provider.
Continue to use `@cursor/sdk` directly, as the official bridge README recommends.

Use the bridge repository as a second contract reference. Its generated proto confirms runtime limits such as cloud-only URL images and artifacts.

Sources:

- <https://github.com/cursor/sdk-bridge>
- <https://github.com/cursor/sdk-bridge/blob/main/README.md>
- <https://github.com/cursor/sdk-bridge/blob/main/proto/sdk/v1/sdk_messages.proto>
- <https://github.com/cursor/sdk-bridge/blob/main/proto/sdk/v1/sdk_agent_service.proto>
- <https://cursor.com/docs/sdk/typescript>

## Review findings

### Correctness findings

The first checkpoint design accepted any suffix with a user turn. The resume prompt then removed assistant and tool turns from that suffix.

The corrected design accepts exactly one new user turn. Any other suffix starts a fresh agent and replays all history.

The first generated-response checkpoint flattened structured parts into text. Visible text could collide with reasoning and tool markers.

The current structured-part refactor keeps the semantic type in the fingerprint. Rendering remains a separate operation.

The first response recorder deduplicated tool calls but not completed tool results. The OpenCode stream did deduplicate completed results.

The response recorder and the stream mapper must use the same completed-tool rule. Otherwise, the next turn starts a false fresh agent.

The first image parser collected text and images in separate passes. This moved all image markers after the combined text.

The structured user parts keep the original text and image order. The Cursor message keeps image bytes in the matching image list order.

### Security findings

The image path has no count, byte, or decoded dimension limit. A large untrusted image request can increase process memory use.

No limit was selected because neither contract supplies one. A later limit needs a product decision and tests.

Fresh transcript reconstruction can contain role-like text from a user or a tool. Cursor receives this transcript as one user message.

This is a model prompt-injection risk. A structured Cursor history operation would be the best fix.

Raw chunks can contain prompts, reasoning, and full tool results. The provider returns them only after an explicit request.

Git metadata can contain private repository details. A remote URL can also contain credentials or query data.

The provider must sanitize Git URLs or omit Git metadata before the compatibility work is complete.

The dependency audit found advisories in transitive `undici` and OpenTelemetry packages. The reviewed feature paths did not expose the known WebSocket condition.

## Cursor SDK facts

The installed SDK exposes these relevant operations and types:

- `SDKUserMessage` with `text` and `images`.
- `Agent.send()` with a model and an `agent` or `plan` mode.
- Local built-in tool allowlists and denylists.
- Local custom callback tools.
- Local MCP server configuration.
- Local sandbox and automatic review controls.
- Model IDs, model parameters, and model variants.
- Streamed text, reasoning, tool activity, status, and token usage.
- Run IDs, request IDs, duration, model data, and Git data.
- Run cancellation when `Run.supports("cancel")` is true.

The SDK also exposes `systemPrompt`, but that option replaces the Cursor harness.

## Verification record

Before the structured conversation refactor, these checks passed:

- The focused suite passed 31 tests.
- The full suite passed 74 tests during independent reviews.
- `bun run typecheck` passed.
- `bun run build` passed during the correctness review.
- `git diff --check` passed.
- The comment review found no workaround comments or suppression comments.

No authenticated Cursor request ran.

## Current work state

The structured conversation refactor is incomplete. `src/bridge/conversation.ts` now defines structured parts.

`src/model/language-model.ts`, `src/bridge/turn.ts`, and their tests still use parts of the old text-only turn shape.
The current type check fails until those call sites move to structured parts.

The next work must do these tasks:

1. Convert AI SDK user content to ordered `UserPart` values.
2. Convert assistant history to `AssistantPart` values.
3. Convert tool history to `ToolPart` values.
4. Record generated output as `AssistantPart` values.
5. Deduplicate completed tool results in the saved response.
6. Use `resumeTurn()` to send exactly one new user turn.
7. Preserve own `__proto__` keys in canonical JSON.
8. Sanitize or omit Git metadata.
9. Update the conversation, binding, turn, and language-model tests.
10. Run `bun test`.
11. Run `bun run typecheck`.
12. Run `bun run build`.
13. Run `git diff --check`.

## Files involved

- `src/plugin.ts` registers the provider and the OpenCode hooks.
- `src/catalog/catalog.ts` maps the Cursor model catalog.
- `src/bridge/agent.ts` adapts Cursor agent creation and send operations.
- `src/bridge/binding.ts` selects one-shot, fresh, or resume routing.
- `src/bridge/conversation.ts` owns structured history, rendering, and fingerprints.
- `src/bridge/translate.ts` maps Cursor SDK messages to bridge events.
- `src/bridge/turn.ts` owns the run lifecycle, cancellation, response recording, and binding updates.
- `src/model/language-model.ts` maps AI SDK V3 calls and results.
- `src/errors.ts` defines explicit provider failures.

## Local-only rule

`.gitignore` excludes this file. Git does not track these notes.
