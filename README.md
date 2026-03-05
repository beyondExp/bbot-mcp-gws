# @bbot/mcp-gws

An MCP server that shells out to the Google Workspace CLI (`gws`, from `googleworkspace/cli`).

## What it does

- Exposes MCP tools:
  - `gws_version`
  - `gws_call` (generic `gws <service> <resource> <method>` wrapper)

## Local development

```bash
cd mcp-gws
npm install
node src/index.js
```

## Auth notes (hosted / E2B)

Interactive OAuth is usually not feasible in ephemeral sandboxes.

This server supports a simple “materialize credentials JSON” helper:

- Set `GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64` to a base64-encoded service account JSON.
- The server writes it to a temp file and sets `GOOGLE_APPLICATION_CREDENTIALS` for the process.

You still need to ensure the underlying `gws` CLI supports your desired auth mode for the APIs you’re calling.

