// Issue #586 (épico #575, 2ª rodada): `chat.ts`'s `snapshot()` passa a
// `SystemPromptSnapshot` inteira (não mais só `.text`) para
// `ConversationRuntime.promptSnapshot` -- este teste prova, contra uma
// invocação REAL de `runChat` (stub HTTP local falando a API Messages da
// Anthropic, mesmo padrão de `tests/chat-audit-trail-wiring.test.ts`), que o
// corpo da requisição chega com `system` em blocos e `cache_control` na
// fronteira stable+context, não a string achatada de antes desta issue.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runChat } from "../src/commands/chat.js";
import { registerProvider } from "../src/providers/registry.js";

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

function anthropicResponse(): Readonly<Record<string, unknown>> {
  return {
    id: "msg_t586",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 2 },
  };
}

/** Captures the raw parsed JSON body of the one `POST /v1/messages` this
 * turn issues (no tool call, so exactly one request — same single-call
 * shape `tests/chat-subscription-*` fixtures already use). */
function startServer(onBody: (body: Readonly<Record<string, unknown>>) => void): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      onBody(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as Readonly<Record<string, unknown>>,
      );
      const text = JSON.stringify(anthropicResponse());
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
}

describe("chat.ts passes the full SystemPromptSnapshot to the Anthropic transport (#586)", () => {
  it("sends system as cache_control blocks, not the pre-#586 flattened string", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t586-chat-"));
    roots.push(root);
    let capturedBody: Readonly<Record<string, unknown>> | undefined;
    const server = startServer((body) => {
      capturedBody = body;
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t586-chat-anthropic-probe";
      registerProvider({
        name: provider,
        apiMode: "anthropic_messages",
        aliases: [],
        displayName: "T586 chat Anthropic probe",
        description: "Local stub for the Anthropic Messages wire (issue #586).",
        signupUrl: "",
        envVars: ["T586_CHAT_KEY"],
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        modelsUrl: "",
        requiresApiKey: true,
        supportsVision: false,
        fallbackModels: ["t586-chat-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });
      const result = await runChat({
        input: "say hi",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t586-chat-model"],
          ["--json", true],
          ["--no-input", true],
          ["--no-tools", true],
        ]),
        environment: {
          HOME: root,
          PATH: process.env.PATH ?? "",
          T586_CHAT_KEY: "test-key",
        },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
      });
      expect(result.code).toBe(0);
      expect(capturedBody).toBeDefined();
      const system = capturedBody?.system;
      expect(Array.isArray(system)).toBe(true);
      const blocks = system as readonly Record<string, unknown>[];
      // The real distinguishing signal for "chat.ts passes the full
      // SystemPromptSnapshot, not just .text": a flat string (pre-#586,
      // and still what every OTHER caller passes) collapses to exactly ONE
      // block via the migration rule (the whole text treated as `stable`).
      // Bands split into stable (cacheable) + volatile (today's date —
      // never empty) here, at least two blocks, only the FIRST cacheable.
      expect(blocks.length).toBeGreaterThan(1);
      expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
      const lastBlock = blocks[blocks.length - 1];
      expect(lastBlock?.cache_control).toBeUndefined();
      expect(String(lastBlock?.text)).toContain("Today's date is");
      for (const block of blocks) expect(block.type).toBe("text");
    } finally {
      await closeServer(server);
    }
  });
});
