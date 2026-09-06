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

/**
 * Two sequential agent nodes (`b` only starts once `a` settles), unlike
 * `workflowSpec()`'s single leaf above. Issue #129: with only ONE leaf, the
 * manual mutation (deleting `dashboard.ts:301`'s
 * `await workflowService.shutdown();`) does not actually reprove — measured
 * directly: `orchestrationCore.shutdown()` (dashboard.ts:293) already
 * cooperatively waits for that one live child, and `visionRunner.close()`'s
 * own real I/O (dashboard.ts:296) happens to give the engine enough turns
 * afterward to finish releasing the lease before `connection.close()`
 * regardless of the mutation. `b` is what makes the mutation observable:
 * `b`'s own child-runner writes its session row to the SAME sqlite
 * connection BEFORE it ever calls the model
 * (`child-runner.ts`'s `ChildConversationRepository.createSession()`) — so
 * once `connection.close()` runs too early (no line 301 to wait on `b`
 * first), `b` throws immediately against the closed connection and never
 * reaches this stub at all; the run still "settles" (with `b` faulted), and
 * the terminal lease-release write that follows ALSO throws against the
 * closed connection — the lease leaks. With the line present,
 * `workflowService.shutdown()` re-reads the run's LIVE state (not
 * `orchestrationCore`'s stale entry snapshot, which never even sees `b`)
 * and waits for it to actually finish before `connection.close()` runs.
 */
function twoNodeWorkflowSpec(): Readonly<Record<string, unknown>> {
  return {
    meta: { name: "durable-dashboard-shutdown" },
    nodes: [
      { id: "a", type: "agent", prompt: "do it" },
      { id: "b", type: "agent", prompt: "after ${a}", depends_on: ["a"] },
    ],
  };
}

/**
 * Issue #129: same shape as `startDurableDashboardServer`, but — molded on
 * `tests/workflow-durable-chat.test.ts`'s `startGatedLeafChatServer` (issue
 * #121, AC 2, reinforced per PR #127's review) — the SECOND main turn's SSE
 * response is held until the FIRST leaf's own request has actually gone out
 * (`leafRequests.count >= 1`), deterministically (no polling, no timer).
 * EVERY leaf request (both `a`'s and `b`'s, via `twoNodeWorkflowSpec()`) is
 * answered only after `leafDelayMs` — a real setTimeout — so each leaf's
 * response is still mid round trip for a while after it is dispatched.
 * `secondLeafAnswered` resolves once `b`'s response has actually been SENT
 * (not merely requested): the test waits on it before reading
 * `workflow_run_locks`, so a run that has not finished settling yet is
 * never mistaken for one whose lease actually leaked.
 */
function startGatedLeafDashboardServer(leafDelayMs: number): {
  readonly server: Server;
  readonly leafRequests: { count: number };
  readonly secondLeafAnswered: Promise<void>;
} {
  let mainCalls = 0;
  const leafRequests = { count: 0 };
  let leafArrived: () => void;
  const leafArrivedOnce = new Promise<void>((resolvePromise) => {
    leafArrived = resolvePromise;
  });
  let secondAnswered: () => void;
  const secondLeafAnswered = new Promise<void>((resolvePromise) => {
    secondAnswered = resolvePromise;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly messages: readonly Readonly<Record<string, unknown>>[];
      };
      const respond = (text: string): void => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "content-length": String(Buffer.byteLength(text)),
        });
        response.end(text);
      };
      if (isLeafRequest(body.messages)) {
        leafRequests.count += 1;
        const ordinal = leafRequests.count;
        leafArrived();
        setTimeout(() => {
          respond(sseTextTurn(`leaf ${String(ordinal)} done`));
          if (ordinal === 2) secondAnswered();
        }, leafDelayMs);
        return;
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        respond(sseToolCallTurn("run_workflow", { spec: twoNodeWorkflowSpec() }));
        return;
      }
      // Turn 2 (workflow started) only answers once the FIRST leaf's own
      // request has actually gone out — see the docstring above.
      void leafArrivedOnce.then(() => {
        respond(sseTextTurn("workflow started"));
      });
    });
  });
  return { server, leafRequests, secondLeafAnswered };
}

function soleRunId(root: string): string {
  const connection = openStateDatabase(join(root, ".lohra", "state.db"));
  try {
    const row = connection.database.prepare("SELECT run_id FROM workflow_run_state").get() as
      { run_id: string } | undefined;
    if (row === undefined) throw new Error("expected exactly one workflow_run_state row");
    return row.run_id;
  } finally {
    connection.close();
  }
}

function lockCountFor(root: string, runId: string): number {
  const connection = openStateDatabase(join(root, ".lohra", "state.db"));
  try {
    const row = connection.database
      .prepare("SELECT count(*) AS n FROM workflow_run_locks WHERE run_id = ?")
      .get(runId) as { n: number | bigint };
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
      // AC 1 also names `auditTrail`, not just `store` — see the identical
      // rationale in tests/workflow-durable-chat.test.ts.
      expect(tableCount(root, "workflow_audit_events")).toBeGreaterThan(0);

      shutdown?.();
      await donePromise;
    } finally {
      await closeServer(server);
    }
  });
});

// Issue #129 — follow-up to #121/PR #127's review (reason 3): `chat.ts`'s
// AC 2 test (`workflow-durable-chat.test.ts`) proved `shutdown()` releases
// a still-gated leaf's lease via `runChat`; `dashboard.ts:301`'s own
// `await workflowService.shutdown();` had no equivalent through
// `runDashboard`'s real WS turn — and a single-leaf equivalent doesn't
// actually reprove the mutation (see `twoNodeWorkflowSpec()`'s docstring
// for the measured reason). `twoNodeWorkflowSpec()`'s SECOND node (`b`) is
// what makes this discriminating: `b` is not yet an `OrchestrationCore`
// entry when the WS turn completes, so only `workflowService.shutdown()`
// still observes and waits for it. This test calls `shutdown()` right
// after the WS turn completes — while `a` is still gated and `b` has not
// even spawned yet — which is the exact window `dashboard.ts:301` exists
// to win: manually deleting that line (restored byte-for-byte after, never
// committed) makes `b` fail before it ever reaches the model, the run's
// terminal lease release then also throws against the closed connection,
// and `workflow_run_locks` stays non-empty — this test red.
describe("dashboard.ts composition root (issue #129): shutdown() releases a still-gated leaf's lease", () => {
  it("workflow_run_locks is empty right after runDashboard shuts down, even though the leaf was still gated when the turn ended", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t129-shutdown-dashboard-"));
    roots.push(root);
    const leafDelayMs = 250;
    const { server, leafRequests, secondLeafAnswered } = startGatedLeafDashboardServer(leafDelayMs);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t129-shutdown-dashboard-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T129 shutdown dashboard probe",
        description: "Local in-memory composition-root probe (issue #129).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t129-shutdown-dashboard-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const stderrLines: string[] = [];
      let shutdown: (() => void) | undefined;
      const options: DashboardCommandOptions = {
        argv: ["--provider", provider, "--model", "t129-shutdown-dashboard-model"],
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
          params: { session_id: sessionId, text: "run the shutdown-dashboard workflow" },
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
      // Guards against a vacuous pass: if `a`'s request never actually went
      // out before the turn completed (a legitimate outcome — see the gated
      // server's docstring above), `b` could never spawn at all and the
      // rest of this test would prove nothing about `dashboard.ts:301`.
      expect(leafRequests.count).toBe(1);
      ws.close();

      // shutdown() fires right here — while `a` is still gated (its
      // response is `leafDelayMs` away) and `b` has not even spawned yet —
      // so the run is still live when dashboard.ts:301's
      // `await workflowService.shutdown();` runs.
      shutdown?.();
      await donePromise;
      // Green: workflowService.shutdown() already waited for the run to
      // settle, so the lock is readable now. This bounded wait exists for
      // the MUTATED path: without dashboard.ts:301, connection.close() runs
      // while `b` is still starting — `b`'s own child-runner writes its
      // session row to that same connection BEFORE it ever calls the model
      // (child-runner.ts's ChildConversationRepository.createSession()), so
      // it throws there and never reaches this stub at all. Racing against
      // a bound instead of awaiting `secondLeafAnswered` unconditionally
      // lets the lock assertion below fail on its own terms instead of
      // vitest's own test timeout.
      await Promise.race([
        secondLeafAnswered,
        new Promise((resolvePromise) => setTimeout(resolvePromise, leafDelayMs * 8)),
      ]);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      // A weaker guard than the chat test's exact `toBe(1)`: whether `b`
      // actually gets far enough to reach this stub before shutdown's
      // cooperative cancel() wins is itself timing-dependent in the GREEN
      // case (either outcome — b completing normally, or the run being
      // cancelled before b ever spawns — releases the lease) — only the
      // lock below is the real discriminator.
      expect(leafRequests.count).toBeGreaterThanOrEqual(1);

      const runId = soleRunId(root);
      expect(lockCountFor(root, runId)).toBe(0);
    } finally {
      await closeServer(server);
    }
  });
});
