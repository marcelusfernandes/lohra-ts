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
          LOHRA_CONTEXT_WINDOW: "4000",
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
