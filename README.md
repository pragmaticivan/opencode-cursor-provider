# opencode-cursor-provider

OpenCode 2 plugin that signs into Cursor with the official SDK and runs Cursor agents from the TUI.

Cursor's agent edits the workspace. OpenCode tools stay off for Cursor models.

## Install

```sh
opencode2 plugin add opencode-cursor-provider
```

Or in `opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-cursor-provider"]
}
```

Local checkout:

```jsonc
{
  "plugins": ["/Users/pragmaticivan/Code/pragmaticivan/opencode-cursor"]
}
```

OpenCode loads `index.ts` from that directory. Restart after changing the plugin:

```sh
opencode2 service restart
```

## Connect

In `opencode2`:

1. `/connect`
2. Choose **Cursor**
3. Browser login, a pasted API key, or `CURSOR_API_KEY`

Then `/models` and pick `cursor/composer-2.5` (or another listed Cursor model).

## Notes

- OpenCode 2 only.
- Login mints a user API key. There is no refresh token. Sign in again when it expires.
- Credentials live in OpenCode. The plugin does not write `~/.cursor/sdk/auth.json`.
