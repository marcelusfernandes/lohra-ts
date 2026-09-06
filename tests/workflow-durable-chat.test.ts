// Issue #101, AC 3: after a real `runChat` turn that dispatches
// `run_workflow`, `workflow_run_state` and `workflow_run_spend` have at
// least one row in the session's own state.db — chat.ts's composition root
// now wires `store`/`auditTrail` into WorkflowService instead of always
// taking the ephemeral, non-persisted branch. Molded on
// tests/workflow-audit-live.test.ts:66-168 (runChat real + a stub HTTP
// server standing in for the provider, HOME in a tmpdir).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runChat } from "../src/commands/chat.js";
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

function chatResponse(
  id: string,
  message: Readonly<Record<string, unknown>>,
  finishReason: string,
): Readonly<Record<string, unknown>> {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: 0,
    model: "t101-durable-chat-model",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

/** A leaf's system prompt always contains this text (subagent-prompt.ts's
 * SUBAGENT_ISOLATION) — the one reliable way to tell a workflow leaf's own
 * model call apart from the main session's, regardless of the order the two
 * independent async request streams reach this single stub server. */
function isLeafRequest(messages: readonly Readonly<Record<string, unknown>>[]): boolean {
  return messages.some(
    (message) =>
      typeof message.content === "string" && message.content.includes("isolated subagent"),
  );
}

function workflowSpec(): Readonly<Record<string, unknown>> {
  return {
    meta: { name: "durable-chat" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
}

/**
 * Turn 1: run_workflow. Turn 2 (once the tool result is in history): plain
 * text — the main session never waits on the leaf. A leaf's own turn (told
 * apart via isLeafRequest) always gets a plain final answer, whether or not
 * it ever actually arrives (orchestrationCore.shutdown() may cooperatively
 * interrupt a leaf before its first iteration ever calls out, and that is
 * fine: the durable launch line/spend seed are written synchronously inside
 * the run_workflow tool call itself, before any leaf runs).
 */
function startDurableChatServer(): { readonly server: Server; readonly port: number } {
  let mainCalls = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly messages: readonly Readonly<Record<string, unknown>>[];
      };
      let payload: Readonly<Record<string, unknown>>;
      if (isLeafRequest(body.messages)) {
        payload = chatResponse("leaf", { role: "assistant", content: "leaf done" }, "stop");
      } else {
        mainCalls += 1;
        payload =
          mainCalls === 1
            ? chatResponse(
                "main-1",
                {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-run-workflow",
                      type: "function",
                      function: {
                        name: "run_workflow",
                        arguments: JSON.stringify({ spec: workflowSpec() }),
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : chatResponse("main-2", { role: "assistant", content: "workflow started" }, "stop");
      }
      const text = JSON.stringify(payload);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
  return { server, port: 0 };
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
 * Issue #121, AC 2: same shape as `startDurableChatServer`, but the leaf's
 * request is what gates the SECOND main turn's response, not a fixed
 * delay — the race the reviewer flagged in PR #127 was that nothing
 * guaranteed the leaf's own request had gone out BEFORE the main turn
 * ended, so a run could settle before shutdown() ever saw it as live. Once
 * the leaf has been dispatched at least once (`leafRequests.count >= 1`),
 * the stub answers turn 2 — deterministic, no polling, no timer — and only
 * THEN, after `leafDelayMs`, answers the leaf itself. That keeps the leaf's
 * own response still in flight (mid HTTP round trip) when both main turns
 * are done and chat.ts's `finally` reaches `orchestrationCore.shutdown()`
 * (chat.ts:388). That drain cooperatively waits for the leaf's real
 * response, exercising the same race `workflowService.shutdown()`
 * (chat.ts:397) exists to lose on purpose: the run's own completion
 * handler releases its lease before `connection.close()`, instead of
 * racing it.
 */
function startGatedLeafChatServer(leafDelayMs: number): {
  readonly server: Server;
  readonly port: number;
  /** Requests the leaf actually made it to (not merely answered) — a test
   * asserting on the lock alone could pass vacuously if the leaf's own
   * request never went out before shutdown (see the module doc above). */
  readonly leafRequests: { count: number };
} {
  let mainCalls = 0;
  const leafRequests = { count: 0 };
  let leafArrived: () => void;
  const leafArrivedOnce = new Promise<void>((resolvePromise) => {
    leafArrived = resolvePromise;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly messages: readonly Readonly<Record<string, unknown>>[];
      };
      const respond = (payload: Readonly<Record<string, unknown>>): void => {
        const text = JSON.stringify(payload);
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
        });
        response.end(text);
      };
      if (isLeafRequest(body.messages)) {
        leafRequests.count += 1;
        leafArrived();
        setTimeout(() => {
          respond(chatResponse("leaf", { role: "assistant", content: "leaf done" }, "stop"));
        }, leafDelayMs);
        return;
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        respond(
          chatResponse(
            "main-1",
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-run-workflow",
                  type: "function",
                  function: {
                    name: "run_workflow",
                    arguments: JSON.stringify({ spec: workflowSpec() }),
                  },
                },
              ],
            },
            "tool_calls",
          ),
        );
        return;
      }
      // Turn 2 (workflow started) only answers once the leaf's own request
      // has actually gone out — see the docstring above.
      void leafArrivedOnce.then(() => {
        respond(chatResponse("main-2", { role: "assistant", content: "workflow started" }, "stop"));
      });
    });
  });
  return { server, port: 0, leafRequests };
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

describe("chat.ts composition root (issue #101, AC 3): run_workflow via runChat persists durably", () => {
  it("after a turn that dispatches run_workflow, workflow_run_state and workflow_run_spend have at least one row", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t101-durable-chat-"));
    roots.push(root);
    const { server } = startDurableChatServer();
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t101-durable-chat-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T101 durable chat probe",
        description: "Local in-memory composition-root probe (issue #101).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t101-durable-chat-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });
      const result = await runChat({
        input: "run the durable-chat workflow",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t101-durable-chat-model"],
          ["--json", true],
          ["--no-input", true],
        ]),
        environment: { HOME: root, PATH: process.env.PATH ?? "" },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
      });
      expect(result.code).toBe(0);
      expect(tableCount(root, "workflow_run_state")).toBeGreaterThan(0);
      expect(tableCount(root, "workflow_run_spend")).toBeGreaterThan(0);
      // AC 1 also names `auditTrail`, not just `store` — without it, no
      // event ever reaches workflow_audit_events regardless of the launch
      // succeeding. announcePlan's auditTrail.record() runs synchronously
      // inside service.start() (the run_workflow tool call itself); by the
      // time runChat returns (its own finally awaits
      // orchestrationCore.shutdown() first), the queued record has had many
      // event-loop turns to drain.
      expect(tableCount(root, "workflow_audit_events")).toBeGreaterThan(0);
    } finally {
      await closeServer(server);
    }
  });
});

describe("chat.ts composition root (issue #121, AC 2): shutdown() releases a still-gated leaf's lease", () => {
  it("workflow_run_locks is empty right after runChat, even though the leaf was still gated when the turn ended", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t121-shutdown-roots-"));
    roots.push(root);
    const { server, leafRequests } = startGatedLeafChatServer(250);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t121-shutdown-roots-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T121 shutdown roots probe",
        description: "Local in-memory composition-root probe (issue #121).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t121-shutdown-roots-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });
      const result = await runChat({
        input: "run the shutdown-roots workflow",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t121-shutdown-roots-model"],
          ["--json", true],
          ["--no-input", true],
        ]),
        environment: { HOME: root, PATH: process.env.PATH ?? "" },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
      });
      expect(result.code).toBe(0);
      // Guards against a vacuous pass: if the leaf's request never actually
      // went out before shutdown (a legitimate outcome — see the module doc
      // above), the lock could be empty for a reason that has nothing to do
      // with workflowService.shutdown().
      expect(leafRequests.count).toBe(1);
      const runId = soleRunId(root);
      expect(lockCountFor(root, runId)).toBe(0);
    } finally {
      await closeServer(server);
    }
  });
});
