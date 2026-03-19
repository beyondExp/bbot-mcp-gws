#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function tryJsonParse(text) {
  const s = (text ?? "").toString().trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseCliOutput(stdout) {
  const s = (stdout ?? "").toString().trim();
  if (!s) return { ok: true, data: null, format: "empty" };

  const direct = tryJsonParse(s);
  if (direct !== null) return { ok: true, data: direct, format: "json" };

  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ndjson = [];
  for (const line of lines) {
    const obj = tryJsonParse(line);
    if (obj !== null) ndjson.push(obj);
  }
  if (ndjson.length > 0) {
    return { ok: true, data: ndjson.length === 1 ? ndjson[0] : ndjson, format: "ndjson" };
  }

  // Fallback: return raw text so callers can still see the error/output.
  return { ok: true, data: { text: s }, format: "text" };
}

function resolveGwsBinary() {
  // Allow explicit override for debugging.
  const override = (process.env.GWS_BIN || "").trim();
  if (override) return override;

  // Prefer the dependency-installed binary.
  const binName = process.platform === "win32" ? "gws.cmd" : "gws";
  const localBin = path.join(__dirname, "..", "node_modules", ".bin", binName);
  if (fs.existsSync(localBin)) return localBin;

  // Fall back to PATH.
  return "gws";
}

function ensureCredentialsFromEnv() {
  // Optional helper for hosted/E2B usage: allow passing a service account JSON
  // as a base64 env var and materialize it as GOOGLE_APPLICATION_CREDENTIALS.
  const b64 = (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64 || "").trim();
  if (!b64) return;
  if ((process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim()) return;

  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(json); // validate it's JSON
    const outPath = path.join(os.tmpdir(), `bbot-gws-creds-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(parsed), { encoding: "utf8", mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = outPath;
  } catch {
    // Ignore invalid payloads; gws may still authenticate another way.
  }
}

async function runGws(args, { timeoutMs = 120000 } = {}) {
  ensureCredentialsFromEnv();
  const gwsBin = resolveGwsBinary();

  return await new Promise((resolve) => {
    const child = spawn(gwsBin, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      resolve({
        code: typeof code === "number" ? code : null,
        signal: signal || null,
        stdout,
        stderr,
        parsed: parseCliOutput(stdout),
      });
    });
  });
}

function toTextContent(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return [{ type: "text", text }];
}

const server = new Server(
  { name: "@bbot/mcp-gws", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "gws_version",
        description: "Return the installed gws version and binary path.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {}
        },
      },
      {
        name: "gws_call",
        description:
          "Call a Google Workspace API via the gws CLI. This is a thin wrapper over: gws <service> <resource> <method> [--params JSON] [--json JSON] [--account EMAIL] [--page-all] [--dry-run].",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["service", "resource", "method"],
          properties: {
            service: { type: "string", description: "Top-level service name (e.g. drive, gmail, calendar, sheets)." },
            resource: { type: "string", description: "Resource name (e.g. files, messages, events, spreadsheets)." },
            method: { type: "string", description: "Method name (e.g. list, get, create, update, delete)." },
            params: { type: ["object", "null"], description: "Query/params object passed as --params JSON." },
            json: { type: ["object", "null"], description: "Request body object passed as --json JSON." },
            account: { type: ["string", "null"], description: "Optional account email passed as --account." },
            page_all: { type: ["boolean", "null"], description: "If true, adds --page-all (when supported)." },
            dry_run: { type: ["boolean", "null"], description: "If true, adds --dry-run (when supported)." },
            timeout_ms: { type: ["number", "null"], minimum: 1000, maximum: 600000, description: "Command timeout in ms." }
          }
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req?.params?.name;
  const input = req?.params?.arguments || {};

  if (name === "gws_version") {
    const gwsBin = resolveGwsBinary();
    const res = await runGws(["--version"], { timeoutMs: 15000 });
    return {
      content: toTextContent({
        gws_bin: gwsBin,
        exit_code: res.code,
        stderr: (res.stderr || "").trim() || null,
        stdout: (res.stdout || "").trim() || null,
      }),
    };
  }

  if (name === "gws_call") {
    const service = (input.service || "").toString().trim();
    const resource = (input.resource || "").toString().trim();
    const method = (input.method || "").toString().trim();
    if (!service || !resource || !method) {
      return { content: toTextContent({ error: "service, resource, and method are required" }), isError: true };
    }

    const args = [service, resource, method];

    if (input.account) {
      args.push("--account", String(input.account));
    }
    if (input.page_all === true) {
      args.push("--page-all");
    }
    if (input.dry_run === true) {
      args.push("--dry-run");
    }
    if (input.params && typeof input.params === "object") {
      args.push("--params", JSON.stringify(input.params));
    }
    if (input.json && typeof input.json === "object") {
      args.push("--json", JSON.stringify(input.json));
    }

    const timeoutMs =
      typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms)
        ? Math.max(1000, Math.min(600000, Math.floor(input.timeout_ms)))
        : 120000;

    const res = await runGws(args, { timeoutMs });

    const payload = {
      ok: res.code === 0,
      exit_code: res.code,
      signal: res.signal,
      stderr: (res.stderr || "").trim() || null,
      result: res.parsed?.data ?? null,
      result_format: res.parsed?.format ?? null,
      invoked: { bin: resolveGwsBinary(), args },
    };

    return {
      content: toTextContent(payload),
      isError: res.code !== 0,
    };
  }

  return { content: toTextContent({ error: `Unknown tool: ${name}` }), isError: true };
});

async function main() {
  const requestedTransport = (process.env.MCP_TRANSPORT || "").toLowerCase().trim();
  const forceStdio = requestedTransport === "stdio";
  const forceHttp = requestedTransport === "streamable_http" || requestedTransport === "http";

  // When running in non-interactive hosts (E2B), stdio is often closed which would
  // cause the process to exit. Default to Streamable HTTP unless stdio is forced.
  const isInteractive = Boolean(process.stdin.isTTY || process.stdout.isTTY);
  const shouldUseHttp = forceHttp || (!forceStdio && (!isInteractive || !!process.env.PORT));

  const logHttp = (...args) => {
    // Some sandbox log streams only capture stdout; some capture stderr. Emit to both in HTTP mode.
    // eslint-disable-next-line no-console
    console.log(...args);
    // eslint-disable-next-line no-console
    console.error(...args);
  };

  const bootMsg =
    `[mcp-gws] boot: transport=${shouldUseHttp ? "streamable_http" : "stdio"} ` +
    `(requested=${requestedTransport || "auto"}, interactive=${isInteractive}, PORT=${process.env.PORT || ""})`;

  if (shouldUseHttp) {
    logHttp(bootMsg);
  } else {
    // eslint-disable-next-line no-console
    console.error(bootMsg);
  }

  if (!shouldUseHttp) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Keep process alive for stdio-based hosts.
    return;
  }

  const port = Number.parseInt(process.env.PORT || "3000", 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  const transport = new StreamableHTTPServerTransport({
    // Stateful mode: client can reuse the same sandbox/runtime across calls.
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname || "/";
      const isMcpPath = pathname === "/mcp" || pathname === "/mcp/" || pathname.startsWith("/mcp/");
      if (!isMcpPath) {
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Not Found");
        return;
      }

      await transport.handleRequest(req, res);
    } catch (err) {
      logHttp("[mcp-gws] HTTP handler error:", err);
      try {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Internal Server Error");
      } catch {
        // ignore
      }
    }
  });

  httpServer.listen(port, "0.0.0.0", () => {
    logHttp(`[mcp-gws] Streamable HTTP listening on :${port} (/mcp)`);
  });

  httpServer.on("error", (err) => {
    logHttp("[mcp-gws] HTTP server error:", err);
    process.exitCode = 1;
  });

  const shutdown = async () => {
    try {
      await transport.close();
    } catch {
      // ignore
    }
    httpServer.close(() => {
      process.exit(0);
    });
    // Ensure we don't hang forever.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[mcp-gws] fatal:", err);
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[mcp-gws] unhandledRejection:", reason);
  process.exitCode = 1;
});

process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("[mcp-gws] uncaughtException:", err);
  process.exitCode = 1;
});

