// Issue #287 (revisor round 2 of PR #284, item 4): nothing that constructs a
// ConversationRuntime in production wires `eventSink` -- "session.compacted"
// only ever reached a test's own fake sink
// (tests/conversation-runtime.test.ts), never a real `lohra chat` run.
// `successEnvelope` already carries `compaction` when a turn compacts (issue
// #252); this pins that `runChat` ALSO surfaces the runtime event itself on
// stderr, observable outside the envelope and outside tests, the way
// warnings/session-resume hints already are.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runChat } from "../src/commands/chat.js";
import { registerProvider } from "../src/providers/registry.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";

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

/** Every request (the default summarizer's own call, then the turn's own
 * model call) gets the same short, fixed reply -- content is irrelevant to
 * this test, only that the turn completes twice without erroring. */
function startFixedReplyServer(): { readonly server: Server } {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const payload = {
        id: "chatcmpl-t287",
        object: "chat.completion",
        created: 0,
        model: "t287-chat-events-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      const text = JSON.stringify(payload);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
  return { server };
}

// 800 filler chars -> ceil(800/2.9) = 276 estimated text tokens per message
// (src/context/token-estimate.ts's TEXT_CHARS_PER_TOKEN) -- 20 turns (40
// messages) is well over any single-digit-thousand token threshold, while
// the turn-aligned kept tail (last 4 turns/8 messages by default,
// DEFAULT_MIN_KEEP_MESSAGES) stays comfortably under it.
function seedLongHistory(root: string, sessionId: string): void {
  const connection = openStateDatabase(join(root, ".lohra", "state.db"));
  const sessions = new SessionRepository(connection.database, undefined, connection.ftsEnabled);
  sessions.createSession({
    id: sessionId,
    model: "t287-chat-events-model",
    systemPrompt: "seed",
    cwd: "/tmp",
  });
  const filler = "x".repeat(800);
  for (let turn = 0; turn < 20; turn += 1) {
    sessions.recordTurn(sessionId, {
      user: { role: "user", content: `q${String(turn)} ${filler}` },
      assistant: { role: "assistant", content: `a${String(turn)} ${filler}`, finishReason: "stop" },
    });
  }
  connection.close();
}

describe("runChat wires eventSink: compaction events reach stderr (issue #287)", () => {
  it('prints "session.compacted" on stderr and keeps the envelope\'s own compaction key when a turn compacts', async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t287-chat-events-"));
    roots.push(root);
    const { server } = startFixedReplyServer();
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t287-chat-events-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T287 chat events probe",
        description: "Local in-memory composition-root probe (issue #287).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t287-chat-events-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const sessionId = "t287-chat-events-session";
      seedLongHistory(root, sessionId);

      const result = await runChat({
        input: "continue",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t287-chat-events-model"],
          ["--json", true],
          ["--no-input", true],
          ["--no-tools", true],
          ["--session", sessionId],
        ]),
        environment: {
          HOME: root,
          PATH: process.env.PATH ?? "",
          // Issue #580: absolute-token ceiling calibrated against a prompt
          // every #575 sub-issue grows (doctrine, then the Harness block) —
          // 4000 left near-zero headroom; 8000 still forces compaction with
          // room to spare against the ~11k-token seeded history below.
          LOHRA_CONTEXT_WINDOW: "8000",
        },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("session.compacted");
      const envelope = JSON.parse(result.stdout) as { compaction?: unknown };
      expect(envelope.compaction).toBeDefined();
    } finally {
      await closeServer(server);
    }
  });
});

// Issue #620 (item 5, veredito da PR #617): nothing exercised `chat.ts`'s
// own `aux_calls` glue (`src/commands/chat.ts:519-537`) end to end -- a
// profile WITH `defaultAuxModel` routes the summary through `AuxTelemetry`
// (`src/agent/aux.ts`) instead of the turn's own default summarizer, and
// `aux_calls` only shows up in the envelope through that path. Same
// fixed-reply local server as above -- no real provider credit, the
// auxiliary call lands on the identical HTTP fixture as the turn's own.
//
// Only the RESUMED-session case (`--session` given) is pinned here. A NEW
// session (no `--session`) that ALSO compacts hits a genuine, pre-existing
// bug outside this issue's `Files`: `ConversationRuntime.runTurn`'s own
// `finally` unconditionally closes `modelTransport`
// (`src/conversation/runtime.ts:792`), which for the parent's own turn
// forwards straight to the underlying client's `close()`
// (`ChatCompletionsModel.close`/`AnthropicMessagesModel.close`,
// `src/conversation/provider-model.ts:34-35,60-61`) -- the SAME raw
// `client` object `chat.ts` hands to `AuxClient` (`src/commands/chat.ts:
// 378-382`). `auxTelemetry.title()` (`chat.ts:521`, only reached when
// `--session` is absent) runs AFTER `runTurn` returns, on an already-closed
// client, and throws `CLIENT_CLOSED` every time -- `chat.ts`'s own
// fail-open `catch` (`title.failed`) swallows it, so today `aux_calls`
// never reaches `2` and no title is ever persisted for a new session with a
// `defaultAuxModel` profile, in production, independent of this issue. The
// mid-turn `summarize` call is unaffected (it runs before `runTurn`'s own
// `finally`). Reported on the issue instead of worked around here --
// fixing it needs `chat.ts` (out of `Files`) or `runtime.ts` (owned by
// #586).
describe("runChat wires AuxClient telemetry: aux_calls in the envelope (issue #620)", () => {
  it("pins aux_calls at 1 (summary only, no title) for a RESUMED session (--session given) that compacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t620-chat-events-resumed-"));
    roots.push(root);
    const { server } = startFixedReplyServer();
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t620-chat-events-probe-resumed";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T620 chat events probe (resumed session)",
        description: "Local in-memory composition-root probe (issue #620).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t287-chat-events-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "t287-chat-events-model",
      });

      const sessionId = "t620-chat-events-resumed-session";
      seedLongHistory(root, sessionId);

      const result = await runChat({
        input: "continue",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t287-chat-events-model"],
          ["--json", true],
          ["--no-input", true],
          ["--no-tools", true],
          ["--session", sessionId],
        ]),
        environment: {
          HOME: root,
          PATH: process.env.PATH ?? "",
          LOHRA_CONTEXT_WINDOW: "8000",
        },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("session.compacted");
      const envelope = JSON.parse(result.stdout) as { compaction?: unknown; aux_calls?: number };
      expect(envelope.compaction).toBeDefined();
      expect(envelope.aux_calls).toBe(1);

      const connection = openStateDatabase(join(root, ".lohra", "state.db"));
      try {
        const sessions = new SessionRepository(
          connection.database,
          undefined,
          connection.ftsEnabled,
        );
        expect(sessions.getSession(sessionId)?.title ?? null).toBeNull();
      } finally {
        connection.close();
      }
    } finally {
      await closeServer(server);
    }
  });
});
