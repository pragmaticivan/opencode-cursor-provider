# AGENTS.md

## Project purpose

This package connects OpenCode 2 to the official Cursor SDK. Cursor owns the coding agent and its tools.

Keep the provider behavior close to native OpenCode providers. Preserve reasoning, tool activity, usage, cancellation, and finish state.

## Repository map

- `src/plugin.ts` registers the integration, catalog, session context, and AI SDK hooks.
- `src/auth/` owns Cursor login, stored credentials, and credential state.
- `src/catalog/` gets Cursor models and maps Cursor variants into the OpenCode catalog.
- `src/bridge/` owns session bindings, prompts, locking, Cursor runs, and SDK message translation.
- `src/model/language-model.ts` maps bridge events into AI SDK V3 results.
- `src/runtime.ts` supports the exported `model()` helper.
- `src/errors.ts` defines the provider error types and user messages.

## Design rules

- Use the official `@cursor/sdk` types and operations.
- Keep Cursor tools separate from OpenCode tools.
- Mark Cursor tool calls as provider-executed AI SDK tool calls.
- Do not convert tool activity into reasoning text.
- Do not report a successful finish after an error or cancellation.
- Connect every `AbortSignal` to `Run.cancel()`.
- Keep one async generator in `runTurn()` unless the stream design changes.
- Use one keyed lock for each OpenCode session.
- Preserve Cursor model parameter values without new interpretation.
- Reject unsupported input. Do not discard it.
- Parse external data at the module boundary.
- Keep strict TypeScript. Do not add `any`, unchecked casts, non-null assertions, or suppression comments.

## Session behavior

The bridge binds one OpenCode session to one Cursor agent. A model change, directory change, rewind, or branch starts a new Cursor agent.

A resumed Cursor agent receives only the new user turns. A one-shot call does not create a session binding.

The context hook puts session data in a private system marker. The language model removes the marker before it creates the Cursor prompt.

## Stream behavior

`src/bridge/translate.ts` maps Cursor SDK messages to the `TurnEvent` union. Keep the union exhaustive.

`src/model/language-model.ts` maps each `TurnEvent` to AI SDK V3. Keep text, reasoning, and tool blocks in their original order.

Use streamed usage first. Use `RunResult.usage` only when the stream has no usage message.

## Change workflow

1. Write a test that shows the missing or incorrect behavior.
2. Run the test and confirm the expected failure.
3. Make the smallest change that passes the test.
4. Run the related tests.
5. Run all project checks.

Use these commands:

```sh
bun test
bun run typecheck
bun run build
```

Do not run an authenticated Cursor request without clear user approval. Do not read or print credentials.

## Documentation

Keep `README.md` focused on package users. Update it when installation, authentication, model selection, behavior, or limits change.

Use `Conventional Commits`. Keep the subject in the imperative form and at 50 characters or less.
