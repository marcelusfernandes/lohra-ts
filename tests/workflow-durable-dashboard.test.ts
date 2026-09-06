// Issue #101, AC 4: after a real `runDashboard` turn (over the actual WS
// gateway protocol) that dispatches `run_workflow`, `workflow_run_state` and
// `workflow_run_spend` have at least one row in the session's own state.db.
// Molded on tests/gateway/dashboard-command.test.ts's real-socket round trip
// (boot via runDashboard, connect a real `ws` client) crossed with
// tests/gateway/prompt-submit.test.ts's JSON-RPC frame protocol
// (session.create -> prompt.submit -> message.start/tool.*/message.complete).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { runDashboard, type DashboardCommandOptions } from "../src/commands/dashboard.js";
import { registerProvider } from "../src/providers/registry.js";
import { openStateDatabase } from "../src/state/connection.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

/**
 * runDashboard always builds its model transports with `streaming: true`
 * (both the main session's ChatCompletionsModel and, via ClientPool, every
 * workflow leaf's own child-runner transport — dashboard.ts:167-172,
 * child-runner.ts:173) — unlike chat.ts's `--json` turn, which forces
 * `streaming: false`. ChatCompletionsClient.stream() sends `stream: true`
 * and parses the response as SSE (`data: {...}\n\n` blocks, `data: [DONE]`
 * terminator — transports/client.ts:247-262), so the stub server has to
 * speak that wire format, not a single JSON completion body.
 */
function sseEvent(delta: Readonly<Record<string, unknown>>, finishReason: string | null): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }], usage: null })}\n\n`;
}

function sseTextTurn(text: string): string {
  return `${sseEvent({ content: text }, null)}${sseEvent({}, "stop")}data: [DONE]\n\n`;
}

function sseToolCallTurn(name: string, args: Readonly<Record<string, unknown>>): string {
  const call = {
    index: 0,
    id: "call-run-workflow",
    function: { name, arguments: JSON.stringify(args) },
  };
  return `${sseEvent({ tool_calls: [call] }, null)}${sseEvent({}, "tool_calls")}data: [DONE]\n\n`;
}

/** Same tell as the chat.ts probe: a leaf's system prompt always contains
 * subagent-prompt.ts's SUBAGENT_ISOLATION text. */
function isLeafRequest(messages: readonly Readonly<Record<string, unknown>>[]): boolean {
  return messages.some(
    (message) =>
      typeof message.content === "string" && message.content.includes("isolated subagent"),
  );
}

function workflowSpec(): Readonly<Record<string, unknown>> {
  return {
    meta: { name: "durable-dashboard" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
}

/** Turn 1: run_workflow. Turn 2+: plain text — see the identical rationale
 * in tests/workflow-durable-chat.test.ts (persistLine/persistSpend land
 * synchronously inside the tool call, before any leaf runs). */
function startDurableDashboardServer(): Server {
  let mainCalls = 0;
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly messages: readonly Readonly<Record<string, unknown>>[];
      };
      let text: string;
      if (isLeafRequest(body.messages)) {
        text = sseTextTurn("leaf done");
      } else {
        mainCalls += 1;
        text =
          mainCalls === 1
            ? sseToolCallTurn("run_workflow", { spec: workflowSpec() })
            : sseTextTurn("workflow started");
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
}

function tableCount(root: string, table: string): number {
  const connection = openStateDatabase(join(root, ".lohra", "state.db"));
  try {
    const row = connection.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number | bigint;
    };
    return Number(row.n);
  } finally {
    connection.close();
  }
}

const messageQueues = new WeakMap<
  WebSocket,
  { readonly queue: string[]; readonly waiters: ((value: string) => void)[] }
>();

function queueFor(ws: WebSocket): {
  readonly queue: string[];
  readonly waiters: ((value: string) => void)[];
} {
  let state = messageQueues.get(ws);
  if (state === undefined) {
    state = { queue: [], waiters: [] };
    messageQueues.set(ws, state);
    ws.on("message", (data) => {
      const text = Buffer.from(data as Buffer).toString("utf8");
      const waiter = state?.waiters.shift();
      if (waiter !== undefined) waiter(text);
      else state?.queue.push(text);
    });
  }
  return state;
}

function nextMessage(ws: WebSocket): Promise<string> {
  const state = queueFor(ws);
  const queued = state.queue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolvePromise) => state.waiters.push(resolvePromise));
}

describe("dashboard.ts composition root (issue #101, AC 4): run_workflow via runDashboard persists durably", () => {
  it("after a WS turn that dispatches run_workflow, workflow_run_state and workflow_run_spend have at least one row", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t101-durable-dashboard-"));
    roots.push(root);
    const server = startDurableDashboardServer();
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t101-durable-dashboard-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T101 durable dashboard probe",
        description: "Local in-memory composition-root probe (issue #101).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t101-durable-dashboard-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const stderrLines: string[] = [];
      let shutdown: (() => void) | undefined;
      const options: DashboardCommandOptions = {
        argv: ["--provider", provider, "--model", "t101-durable-dashboard-model"],
        environment: { HOME: root, PATH: process.env.PATH ?? "" },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
        stderr: (text) => stderrLines.push(text),
        port: 0,
        registerShutdownTrigger: (handler) => {
          shutdown = handler;
        },
      };
      const donePromise = runDashboard(options);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      const boundLine = stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
      const port = Number(boundLine?.match(/:(\d+)\n$/)?.[1]);
      const wsLine = stderrLines.find((line) => line.startsWith("WebSocket:"));
      const token = wsLine?.match(/token=([^\n]+)\n$/)?.[1];
      expect(token).toBeDefined();

      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws?token=${String(token)}`);
      await nextMessage(ws); // gateway.ready
      ws.send(
        JSON.stringify({ jsonrpc: "2.0", id: "create", method: "session.create", params: {} }),
      );
      const createResult = JSON.parse(await nextMessage(ws)) as {
        result: { session_id: string };
      };
      await nextMessage(ws); // session.info
      const sessionId = createResult.result.session_id;

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "prompt.submit",
          params: { session_id: sessionId, text: "run the durable-dashboard workflow" },
        }),
      );
      await nextMessage(ws); // rpc-ok
      let complete: { params: { type: string; payload: unknown } } | undefined;
      while (complete === undefined) {
        const frame = JSON.parse(await nextMessage(ws)) as {
          params: { type: string; payload: unknown };
        };
        if (frame.params.type === "message.complete") complete = frame;
      }
      expect((complete.params.payload as { status: string }).status).toBe("complete");
      ws.close();

      expect(tableCount(root, "workflow_run_state")).toBeGreaterThan(0);
      expect(tableCount(root, "workflow_run_spend")).toBeGreaterThan(0);

      shutdown?.();
      await donePromise;
    } finally {
      await closeServer(server);
    }
  });
});
