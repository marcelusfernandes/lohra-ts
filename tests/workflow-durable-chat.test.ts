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
    } finally {
      await closeServer(server);
    }
  });
});
