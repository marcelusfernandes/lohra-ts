// Issue #383, item 5 (emenda do orquestrador, veredito da PR #384/#380):
// `chat.ts:352` builds its OWN `AuditTrail` with `{ warning: auditWarning }`
// — a SEPARATE sink from the one `createSessionToolBase` wires into
// `AuditRepository.append`'s ownership-refusal warn (#380, pinned by
// `tests/workflow-audit-identity.test.ts`'s "audit warning sink" describe).
// `AuditTrail`'s own `warning` fires for a DIFFERENT class of failure —
// `sink_failure`/queue overflow inside the trail's own drain (audit-trail.ts)
// — never exercised through `chat.ts` before. `chat.ts` hardcodes
// `auditWarning` to `console.warn` with no injectable stderr/logger surface
// on `ChatCommandOptions` (unlike `src/commands/workflow.ts`'s
// `productionWarningSink((message) => options.stderr(...))` pattern), so the
// only observable proxy for "the sink chat.ts actually wired in" is spying
// `console.warn` and matching the EXACT message text only `AuditTrail.
// append`'s own `this.warning(...)` call produces — never a loose "some
// warn happened" assertion, which could pass for an unrelated reason.
//
// Mutant `W2-audit-trail-warning-unwired` deletes `{ warning: auditWarning }`
// from `new AuditTrail(...)` (chat.ts:352) — the trail then defaults to
// `() => undefined`, so this test's matched-message count goes from exactly
// one to zero.
//
// Molded on `tests/workflow-durable-chat.test.ts`'s `startDurableChatServer`
// harness (real `runChat`, a stub HTTP server standing in for the provider,
// HOME in a tmpdir) — duplicated here rather than imported, same convention
// as every other file in this suite. `AuditRepository.prototype.append` is
// spied to throw ONCE, a non-busy error so `AuditTrail.append` never
// retries: the `segment.started` audit write `service.start()` makes
// synchronously inside the `run_workflow` tool call (same fact
// `workflow-durable-chat.test.ts` already documents: "the queued record has
// had many event-loop turns to drain" by the time `runChat` returns) is the
// very first append this session ever makes, so the throw lands there.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runChat } from "../src/commands/chat.js";
import { registerProvider } from "../src/providers/registry.js";
import { AuditRepository } from "../src/state/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
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
    model: "t383-audit-wiring-model",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function workflowSpec(): Readonly<Record<string, unknown>> {
  return {
    meta: { name: "audit-wiring" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
}

/** Turn 1: run_workflow. Turn 2 (tool result already in history): plain
 * text — same "the launch line is written synchronously inside the
 * run_workflow call itself" shape `workflow-durable-chat.test.ts` relies on;
 * no leaf ever needs to actually run for this test's sink_failure to fire. */
function startServer(): Server {
  let mainCalls = 0;
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      mainCalls += 1;
      const payload =
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
      const text = JSON.stringify(payload);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
}

describe("chat.ts wires { warning: auditWarning } into its own AuditTrail (issue #383, item 5)", () => {
  it("a sink_failure on the run's first audit write reaches console.warn via chat.ts's AuditTrail sink", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t383-audit-wiring-"));
    roots.push(root);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(AuditRepository.prototype, "append").mockImplementationOnce(() => {
      throw new Error("t383 sink_failure probe");
    });
    const server = startServer();
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t383-audit-wiring-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T383 audit wiring probe",
        description: "Local in-memory composition-root probe (issue #383).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t383-audit-wiring-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });
      const result = await runChat({
        input: "run the audit-wiring workflow",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t383-audit-wiring-model"],
          ["--json", true],
          ["--no-input", true],
        ]),
        environment: { HOME: root, PATH: process.env.PATH ?? "" },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
      });
      expect(result.code).toBe(0);
      const matched = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => /audit append failed for run/.test(message));
      expect(matched).toHaveLength(1);
    } finally {
      await closeServer(server);
    }
  });
});
