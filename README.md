# opencode-cursor-provider

Use Cursor models and the Cursor coding agent in OpenCode 2. The plugin uses the official Cursor SDK.

The Cursor coding agent can read and change your workspace. OpenCode shows Cursor reasoning and tool activity in the session.

## Requirements

- OpenCode 2
- Node.js 22.13 or later
- A Cursor account or a Cursor API key

## Install the plugin

Run this command:

```sh
opencode2 plugin add opencode-cursor-provider
```

You can also add the plugin to `opencode.jsonc`:

```jsonc
{
	"plugins": ["opencode-cursor-provider"]
}
```

Restart OpenCode after you change the plugin configuration.

## Connect Cursor

1. Start `opencode2`.
2. Run `/connect`.
3. Select **Cursor**.
4. Select browser login, API key, or `CURSOR_API_KEY`.

Browser login creates a user API key. Sign in again when the key expires.

## Select a model

1. Run `/models`.
2. Select a model under **Cursor**.

The plugin gets the model list and the model variants from Cursor. The fallback list includes `cursor/composer-2.5` and `cursor/auto`.

## How the plugin works

- Cursor runs its own tools and changes the workspace.
- OpenCode tools stay off for Cursor models.
- OpenCode shows Cursor tools as provider-executed tool calls.
- The plugin keeps one Cursor agent for each OpenCode session.
- The plugin starts a new Cursor agent after a model, directory, mode, conversation, or Cursor agent option change.
- OpenCode cancellation stops the active Cursor run.
- You can set Cursor plan mode with `providerOptions.cursor.mode`.

The provider supports these Cursor agent options:

```ts
providerOptions: {
	cursor: {
		mode: "plan",
		tools: ["read", "grep"],
		disallowedTools: ["shell"],
		sandboxOptions: { enabled: true },
		autoReview: true,
		settingSources: ["project", "team"],
	},
}
```

The `tools` and `disallowedTools` options apply only to Cursor tools. They do not add OpenCode tools.

Because Cursor settings can load MCP servers, select only settings layers that you trust.

## Current limits

- The plugin supports text and local image input. It supports text output.
- The plugin rejects image URLs and non-image file input. It does not discard the input.
- The plugin rejects structured output requests.
- The plugin rejects OpenCode tools and explicit tool choice.
- OpenCode sampling settings do not change Cursor model parameters. The plugin reports those settings as unsupported.
- Cursor controls tool access and tool approval for its tools.
- The plugin does not expose Cursor MCP servers, custom tools, extra workspace roots, or a replacement system prompt.

## Credentials

OpenCode stores the Cursor credentials. The plugin does not write `~/.cursor/sdk/auth.json`.

You can set `CURSOR_API_KEY` when you do not want to store a connection in OpenCode.

## Develop the plugin

Install the dependencies:

```sh
bun install
```

Run the checks:

```sh
bun test
bun run typecheck
bun run build
```

The source code is in `src/`. The build writes the package files to `dist/`.

## Release

Releases use [Release Please](https://github.com/googleapis/release-please) with conventional commits (`feat:`, `fix:`, `docs:`, …). Merging to `main` opens or updates a release PR. Merging that PR tags a GitHub release and publishes to npm.

Configure an npm trusted publisher with these values:

- Organization or user: `pragmaticivan`
- Repository: `opencode-cursor-provider`
- Workflow filename: `release-please.yml`
- Allowed action: `npm publish`

The workflow uses OpenID Connect and does not need an npm token.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
