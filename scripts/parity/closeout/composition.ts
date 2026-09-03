import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocket } from "ws";
import Database from "better-sqlite3";

import { CronStore } from "../../../src/cron/store.js";
import { evidenceTargetSha } from "./evidence.js";

const project = resolve(import.meta.dirname, "../../..");
const installedRoot = process.env.LOHRA_T22_INSTALLED_ROOT ?? project;
const cliPath = process.env.LOHRA_T22_CLI ?? join(installedRoot, "dist", "cli.js");
const root = mkdtempSync(join(tmpdir(), "lohra-t22-composition-"));
const home = join(root, "home");
const cwd = join(root, "project");
const evidenceDirectory = join(project, ".parity-evidence", "t22");
mkdirSync(home, { recursive: true });
mkdirSync(cwd, { recursive: true });

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const calls = [
  ["workflow_audit", { run_id: "missing" }],
  ["run_workflow", { spec: {} }],
  ["web_fetch", { url: "http://127.0.0.1/private" }],
  ["web_search", {}],
  ["vision_analyze", { source: `data:image/png;base64,${tinyPng}` }],
  ["image_gen", { prompt: "one blue pixel", n: 1 }],
  ["spawn_session", { prompt: "child work" }],
  ["cronjob", { action: "list" }],
  ["mcp_fixture_ping", { value: "ok" }],
] as const;

interface CapturedRequest {
  readonly surface: "chat" | "dashboard";
  readonly tool: string;
  readonly toolNames: readonly string[];
  readonly toolResult: string | null;
}

const captured: CapturedRequest[] = [];
let surface: "chat" | "dashboard" = "chat";

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on("error", reject);
  });
}

function messagesOf(body: Record<string, unknown>): readonly Record<string, unknown>[] {
  return Array.isArray(body.messages) ? (body.messages as readonly Record<string, unknown>[]) : [];
}

function requestedTool(messages: readonly Record<string, unknown>[]): string | null {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const match = /TOOL:([a-z0-9_]+)/u.exec(message.content);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function sendJson(response: ServerResponse, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

function completion(message: Record<string, unknown>, finishReason: string): unknown {
  return {
    id: "t22",
    object: "chat.completion",
    created: 0,
    model: "fixture",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function sendStream(
  response: ServerResponse,
  value: { readonly tool?: string; readonly args?: string; readonly content?: string },
): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
    response.write(
      `data: ${JSON.stringify({
        id: "t22",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };
  frame({ role: "assistant", content: null });
  if (value.tool !== undefined) {
    frame({
      tool_calls: [
        {
          index: 0,
          id: "call_t22",
          type: "function",
          function: { name: value.tool, arguments: value.args ?? "{}" },
        },
      ],
    });
    frame({}, "tool_calls");
  } else {
    frame({ content: value.content ?? "fixture-ok" });
    frame({}, "stop");
  }
  response.write(
    `data: ${JSON.stringify({
      id: "t22",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

const upstream = createServer((request, response) => {
  void (async () => {
    if (request.url?.endsWith("/images/generations") === true) {
      await readBody(request);
      sendJson(response, { data: [{ b64_json: tinyPng }] });
      return;
    }
    const body = await readBody(request);
    const messages = messagesOf(body);
    const tool = requestedTool(messages);
    const last = messages.at(-1);
    const definitions = Array.isArray(body.tools)
      ? (body.tools as readonly { function?: { name?: unknown } }[])
          .map((entry) => entry.function?.name)
          .filter((name): name is string => typeof name === "string")
      : [];
    if (last?.role === "tool" && tool !== null) {
      captured.push({
        surface,
        tool,
        toolNames: definitions,
        toolResult: typeof last.content === "string" ? last.content : null,
      });
      if (body.stream === true) sendStream(response, { content: "fixture-ok" });
      else sendJson(response, completion({ role: "assistant", content: "fixture-ok" }, "stop"));
      return;
    }
    if (tool === null) {
      if (body.stream === true) sendStream(response, { content: "vision-ok" });
      else sendJson(response, completion({ role: "assistant", content: "vision-ok" }, "stop"));
      return;
    }
    const spec = calls.find(([name]) => name === tool);
    if (spec === undefined) throw new Error(`unknown fixture tool ${tool}`);
    const args = JSON.stringify(spec[1]);
    if (body.stream === true) sendStream(response, { tool, args });
    else {
      sendJson(
        response,
        completion(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_t22", type: "function", function: { name: tool, arguments: args } },
            ],
          },
          "tool_calls",
        ),
      );
    }
  })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
});

function waitForListen(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => {
      const address = upstream.address();
      if (address === null || typeof address === "string") reject(new Error("upstream address"));
      else resolvePort(address.port);
    });
  });
}

function closeUpstream(): Promise<void> {
  return new Promise((resolveClose, reject) => {
    upstream.close((error) => {
      if (error === undefined) resolveClose();
      else reject(error);
    });
    upstream.closeAllConnections();
  });
}

function runProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolveProcess({ code: code ?? -1, stdout, stderr });
    });
  });
}

const socketQueues = new WeakMap<
  WebSocket,
  {
    readonly values: Record<string, unknown>[];
    readonly waiters: Array<(value: Record<string, unknown>) => void>;
  }
>();

function socketQueue(socket: WebSocket) {
  let queue = socketQueues.get(socket);
  if (queue !== undefined) return queue;
  queue = { values: [], waiters: [] };
  socketQueues.set(socket, queue);
  socket.on("message", (data) => {
    const value = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as Record<
      string,
      unknown
    >;
    const waiter = queue.waiters.shift();
    if (waiter === undefined) queue.values.push(value);
    else waiter(value);
  });
  return queue;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const queue = socketQueue(socket);
  const value = queue.values.shift();
  if (value !== undefined) return Promise.resolve(value);
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("dashboard websocket timeout"));
    }, 10_000);
    queue.waiters.push((message) => {
      clearTimeout(timer);
      resolveMessage(message);
    });
  });
}

async function main(): Promise<void> {
  const port = await waitForListen();
  const loader = join(root, "mcp-loader.mjs");
  const sessionUrl = pathToFileURL(join(installedRoot, "dist", "mcp", "session.js")).href;
  writeFileSync(
    loader,
    `import { defaultSessionFactory } from ${JSON.stringify(sessionUrl)};\n` +
      `defaultSessionFactory.current = async () => ({\n` +
      ` listTools: async () => [{name:"ping",description:"fixture",inputSchema:{type:"object"}}],\n` +
      ` callTool: async () => ({content:[{type:"text",text:"mcp-ok"}],isError:false}),\n` +
      ` close: async () => undefined,\n` +
      `});\n`,
  );
  writeFileSync(
    join(home, "mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { command: process.execPath } } }),
  );
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.LOHRA_T22_PATH ?? `${resolve(process.execPath, "..")}:/usr/bin:/bin`,
    HOME: home,
    LOHRA_HOME: home,
    CODEX_HOME: join(home, "codex"),
    TMPDIR: join(root, "tmp"),
    TZ: "UTC",
    NO_COLOR: "1",
    LOHRA_NO_WIZARD: "1",
    LOHRA_PROVIDER_BASE_URL: `http://127.0.0.1:${String(port)}/v1`,
    NO_PROXY: "127.0.0.1,localhost",
  };
  mkdirSync(environment.TMPDIR as string, { recursive: true });

  surface = "chat";
  for (const [tool] of calls) {
    const result = await runProcess(
      process.execPath,
      [
        "--import",
        loader,
        cliPath,
        "chat",
        `TOOL:${tool}`,
        "--json",
        "--provider",
        "ollama",
        "--model",
        "fixture",
        "--no-input",
      ],
      environment,
    );
    if (result.code !== 0) throw new Error(`chat ${tool} failed: ${result.stderr}`);
  }

  surface = "dashboard";
  const cronStore = new CronStore(home);
  const cronJob = cronStore.add({
    name: "t22-due",
    prompt: "TOOL:cronjob",
    type: "once",
    value: 0,
  });
  const dashboard = spawn(
    process.execPath,
    [
      "--import",
      loader,
      cliPath,
      "dashboard",
      "--insecure",
      "--port",
      "0",
      "--provider",
      "ollama",
      "--model",
      "fixture",
    ],
    { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let dashboardStderr = "";
  dashboard.stderr.setEncoding("utf8");
  dashboard.stderr.on("data", (chunk: string) => (dashboardStderr += chunk));
  const dashboardPort = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dashboard boot timeout: ${dashboardStderr}`));
    }, 10_000);
    const inspect = (): void => {
      const match = /Lohra dashboard: http:\/\/127\.0\.0\.1:(\d+)/u.exec(dashboardStderr);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    };
    dashboard.stderr.on("data", inspect);
    dashboard.once("exit", (code) => {
      reject(new Error(`dashboard exited ${String(code)}: ${dashboardStderr}`));
    });
  });
  const socket = new WebSocket(`ws://127.0.0.1:${String(dashboardPort)}/api/ws`);
  await nextMessage(socket);
  for (const [tool] of calls) {
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `create-${tool}`,
        method: "session.create",
        params: {},
      }),
    );
    const created = await nextMessage(socket);
    await nextMessage(socket);
    const result = created.result as { session_id?: unknown } | undefined;
    if (typeof result?.session_id !== "string") throw new Error(`dashboard create ${tool}`);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `prompt-${tool}`,
        method: "prompt.submit",
        params: { session_id: result.session_id, text: `TOOL:${tool}` },
      }),
    );
    for (;;) {
      const message = await nextMessage(socket);
      const event = message.params as { type?: unknown } | undefined;
      if (event?.type === "message.complete") break;
    }
  }
  const spawnResult = captured.find(
    (entry) => entry.surface === "dashboard" && entry.tool === "spawn_session",
  )?.toolResult;
  if (spawnResult === undefined || spawnResult === null) {
    throw new Error("COMPOSITION_SUBSESSION_MISSING");
  }
  const spawned = JSON.parse(spawnResult) as { sub_id?: unknown };
  if (typeof spawned.sub_id !== "string") throw new Error("COMPOSITION_SUBSESSION_ID_MISSING");
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "promotion-denied",
      method: "prompt.submit",
      params: { session_id: spawned.sub_id, text: "promote me" },
    }),
  );
  const promotion = await nextMessage(socket);
  const promotionError = promotion.error as { code?: unknown; message?: unknown } | undefined;
  if (
    promotionError?.code !== -32602 ||
    promotionError.message !== "subsession cannot be promoted to a gateway session"
  ) {
    throw new Error("COMPOSITION_SUBSESSION_PROMOTION_NOT_DENIED");
  }
  socket.close();
  dashboard.kill("SIGINT");
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("dashboard shutdown timeout"));
    }, 10_000);
    dashboard.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveExit();
      else reject(new Error(`dashboard exit ${String(code)}: ${dashboardStderr}`));
    });
  });
  const completedCron = cronStore.get(cronJob.id);
  if (completedCron?.last_run_at === null || completedCron === null) {
    throw new Error("COMPOSITION_CRON_NOT_RUN");
  }
  const database = new Database(join(home, "state.db"), { readonly: true });
  const sessionCount = (
    database.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number }
  ).count;
  const messageCount = (
    database.prepare("SELECT count(*) AS count FROM messages").get() as { count: number }
  ).count;
  database.close();
  if (sessionCount < calls.length + 1 || messageCount < 2) {
    throw new Error("COMPOSITION_CRON_SESSION_NOT_PERSISTED");
  }

  for (const targetSurface of ["chat", "dashboard"] as const) {
    const rows = captured.filter((entry) => entry.surface === targetSurface);
    for (const [tool] of calls) {
      const row = rows.find((entry) => entry.tool === tool);
      if (row?.toolResult === null || row?.toolResult === undefined) {
        throw new Error(`COMPOSITION_RESULT_MISSING:${targetSurface}:${tool}`);
      }
      if (/must be intercepted|deferred|placeholder/iu.test(row.toolResult)) {
        throw new Error(`COMPOSITION_PLACEHOLDER:${targetSurface}:${tool}`);
      }
      const required = calls.map(([name]) => name);
      if (!required.every((name) => row.toolNames.includes(name))) {
        throw new Error(`COMPOSITION_DEFINITION_MISSING:${targetSurface}:${tool}`);
      }
    }
  }
  const observation = {
    targetSha: evidenceTargetSha(project),
    chat: captured.filter((entry) => entry.surface === "chat").map((entry) => entry.tool),
    dashboard: captured.filter((entry) => entry.surface === "dashboard").map((entry) => entry.tool),
    placeholders: 0,
    cron: { ran: true, sessionPersisted: true },
    l22: { denied: true, code: -32602, cause: "SUBSESSION_PRIVILEGE_PROMOTION_DENIED" },
    networkUsed: false,
    credentialsUsed: false,
  };
  const canonical = `${JSON.stringify(observation)}\n`;
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, "composition.json"), canonical);
  process.stdout.write(
    `${JSON.stringify({ ...observation, digest: createHash("sha256").update(canonical).digest("hex") })}\n`,
  );
}

try {
  await main();
} finally {
  await closeUpstream();
  rmSync(root, { recursive: true, force: true });
}
