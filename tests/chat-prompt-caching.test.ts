// Issue #586 (épico #575, 2ª rodada): `chat.ts`'s `snapshot()` passa a
// `SystemPromptSnapshot` inteira (não mais só `.text`) para
// `ConversationRuntime.promptSnapshot` -- este teste prova, contra uma
// invocação REAL de `runChat` (stub HTTP local falando a API Messages da
// Anthropic, mesmo padrão de `tests/chat-audit-trail-wiring.test.ts`), que o
// corpo da requisição chega com `system` em blocos e `cache_control` na
// fronteira stable+context, não a string achatada de antes desta issue.
//
// Issue #624: a asserção original pinava `blocks[0]` -- só vale porque a
// faixa `context` está vazia neste tmpdir; se algo cair em `context`, o
// breakpoint migra para `blocks[1]` sem regressão real.
// `assertSingleBreakpointBeforeDateBlock` localiza o bloco com
// `cache_control` por busca, não por índice fixo, e prende a invariante que
// importa: exatamente um bloco cacheado, imediatamente antes do bloco da
// faixa `volatile` (a data, que nunca é vazia -- `buildSystemPrompt` sempre
// anexa `Today's date is ...`). O segundo `it` roda o MESMO turno sem
// `--no-tools`, exercitando o breakpoint de `cache_control` na última
// definição de tool (`cachedToolDefinitions`,
// `src/transports/anthropic-messages.ts`) -- ausente da integração até
// agora, só coberto em unidade (`tests/transport-anthropic-messages.test.ts`).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Issue #624: robust replacement for pinning `blocks[0]` -- finds the
 * cache_control breakpoint by scanning (there must be EXACTLY one) and
 * asserts it sits immediately before the block carrying the volatile
 * band's date, wherever that lands once `context` stops being empty. */
function assertSingleBreakpointBeforeDateBlock(blocks: readonly Record<string, unknown>[]): void {
  const cachedIndexes = blocks
    .map((block, index) => (block.cache_control === undefined ? -1 : index))
    .filter((index) => index !== -1);
  expect(cachedIndexes).toHaveLength(1);
  const cachedIndex = cachedIndexes[0] as number;
  const dateBlock = blocks[cachedIndex + 1];
  expect(dateBlock).toBeDefined();
  expect(dateBlock?.cache_control).toBeUndefined();
  expect(String(dateBlock?.text)).toContain("Today's date is");
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
      // never empty) here, at least two blocks.
      expect(blocks.length).toBeGreaterThan(1);
      assertSingleBreakpointBeforeDateBlock(blocks);
      for (const block of blocks) expect(block.type).toBe("text");
    } finally {
      await closeServer(server);
    }
  });

  it("also marks cache_control on the last tool definition when tools are enabled (no --no-tools)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t586-chat-tools-"));
    roots.push(root);
    let capturedBody: Readonly<Record<string, unknown>> | undefined;
    const server = startServer((body) => {
      capturedBody = body;
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t624-chat-tools-anthropic-probe";
      registerProvider({
        name: provider,
        apiMode: "anthropic_messages",
        aliases: [],
        displayName: "T624 chat tools Anthropic probe",
        description: "Local stub for the Anthropic Messages wire (issue #624).",
        signupUrl: "",
        envVars: ["T624_CHAT_TOOLS_KEY"],
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        modelsUrl: "",
        requiresApiKey: true,
        supportsVision: false,
        fallbackModels: ["t624-chat-tools-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });
      const result = await runChat({
        input: "say hi",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t624-chat-tools-model"],
          ["--json", true],
          ["--no-input", true],
        ]),
        environment: {
          HOME: root,
          PATH: process.env.PATH ?? "",
          T624_CHAT_TOOLS_KEY: "test-key",
        },
        home: join(root, ".lohra"),
        codexHome: join(root, ".codex"),
        cwd: root,
      });
      expect(result.code).toBe(0);
      expect(capturedBody).toBeDefined();
      expect(Array.isArray(capturedBody?.tools)).toBe(true);
      const tools = capturedBody?.tools as readonly Record<string, unknown>[];
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools.slice(0, -1)) expect(tool.cache_control).toBeUndefined();
      expect(tools[tools.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
    } finally {
      await closeServer(server);
    }
  });

  // Issue #648 (grupo A, item 7e de #637; veredito PR #628, reason 3): every
  // fixture above has an EMPTY `context` band -- no `AGENTS.md`/`CLAUDE.md`
  // in the tmpdir `cwd` -- so the "breakpoint lands on `context` when it's
  // the last cacheable segment" branch of `cachedSegments`
  // (src/transports/anthropic-messages.ts:39-41) never ran against a real
  // `runChat` turn. Seeding an `AGENTS.md` here makes `context` non-empty:
  // stable, context, and volatile all become real segments, and the single
  // cache breakpoint must move onto `context` -- the block immediately
  // before the date block, whose own text carries the seeded content.
  it("marks cache_control on the context band (not stable) when project instructions are present (#648)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t648-chat-context-cache-"));
    roots.push(root);
    writeFileSync(join(root, "AGENTS.md"), "T648-AGENTS-MARKER");
    let capturedBody: Readonly<Record<string, unknown>> | undefined;
    const server = startServer((body) => {
      capturedBody = body;
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t648-chat-context-cache-probe";
      registerProvider({
        name: provider,
        apiMode: "anthropic_messages",
        aliases: [],
        displayName: "T648 chat context-cache Anthropic probe",
        description: "Local stub for the Anthropic Messages wire (issue #648).",
        signupUrl: "",
        envVars: ["T648_CHAT_CONTEXT_CACHE_KEY"],
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        modelsUrl: "",
        requiresApiKey: true,
        supportsVision: false,
        fallbackModels: ["t648-chat-context-cache-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });
      const result = await runChat({
        input: "say hi",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t648-chat-context-cache-model"],
          ["--json", true],
          ["--no-input", true],
          ["--no-tools", true],
        ]),
        environment: {
          HOME: root,
          PATH: process.env.PATH ?? "",
          T648_CHAT_CONTEXT_CACHE_KEY: "test-key",
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
      // Non-empty context makes THREE segments (stable, context, volatile) --
      // strictly more than the two the byte-compat fixtures above produce.
      expect(blocks.length).toBeGreaterThan(2);
      assertSingleBreakpointBeforeDateBlock(blocks);
      const cachedIndex = blocks.findIndex((block) => block.cache_control !== undefined);
      expect(String(blocks[cachedIndex]?.text)).toContain("T648-AGENTS-MARKER");
    } finally {
      await closeServer(server);
    }
  });
});

// Issue #649 (sub-issue B1 de #637, AC3): o request Anthropic da sessão
// retomada tem de ser byte-idêntico ao gravado — não só ao nível de
// `ConversationRuntime` (`tests/conversation-sqlite-prompt-caching.test.ts`),
// mas pela wiring real de `chat.ts`: dois `runChat` inteiros, o segundo
// retomando via `--session`, sobre o MESMO `home` (mesmo state.db). O
// segundo processo resolve uma doutrina DIFERENTE do primeiro
// (`LOHRA_DOCTRINE` muda entre as duas chamadas) — a única forma de provar
// que o corpo enviado ao provedor vem do banco, não da closure deste
// processo.
describe("chat.ts resumed session sends the request Anthropic byte-identical to what was persisted (#649)", () => {
  it("a second runChat --session reuses the FIRST call's system bands, never this process's own doctrine/date", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t649-chat-resume-"));
    roots.push(root);
    const bodies: Readonly<Record<string, unknown>>[] = [];
    const server = startServer((body) => {
      bodies.push(body);
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t649-chat-resume-anthropic-probe";
      registerProvider({
        name: provider,
        apiMode: "anthropic_messages",
        aliases: [],
        displayName: "T649 chat resume Anthropic probe",
        description: "Local stub for the Anthropic Messages wire (issue #649).",
        signupUrl: "",
        envVars: ["T649_CHAT_RESUME_KEY"],
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        modelsUrl: "",
        requiresApiKey: true,
        supportsVision: false,
        fallbackModels: ["t649-chat-resume-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });
      const baseEnvironment = {
        HOME: root,
        PATH: process.env.PATH ?? "",
        T649_CHAT_RESUME_KEY: "test-key",
      };
      const home = join(root, ".lohra");
      const codexHome = join(root, ".codex");

      const result1 = await runChat({
        input: "say hi",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t649-chat-resume-model"],
          ["--json", true],
          ["--no-input", true],
          ["--no-tools", true],
        ]),
        environment: { ...baseEnvironment, LOHRA_DOCTRINE: "core" },
        home,
        codexHome,
        cwd: root,
      });
      expect(result1.code).toBe(0);
      const sessionId = (JSON.parse(result1.stdout) as { session_id?: string }).session_id;
      expect(typeof sessionId).toBe("string");
      expect(bodies).toHaveLength(1);

      // A second PROCESS-EQUIVALENT call resuming the SAME session, with a
      // DIFFERENT doctrine resolved for this process's own promptSnapshot()
      // (never actually used, since the session is resumed, not created).
      const result2 = await runChat({
        input: "say hi again",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t649-chat-resume-model"],
          ["--json", true],
          ["--no-input", true],
          ["--no-tools", true],
          ["--session", sessionId as string],
        ]),
        environment: { ...baseEnvironment, LOHRA_DOCTRINE: "extended" },
        home,
        codexHome,
        cwd: root,
      });
      expect(result2.code).toBe(0);
      expect(bodies).toHaveLength(2);

      const system1 = JSON.stringify(bodies[0]?.system);
      const system2 = JSON.stringify(bodies[1]?.system);
      // Byte-identical: the second request's `system` is exactly what the
      // first call persisted, never recomputed for this second call.
      expect(system2).toBe(system1);
      // Pin against a false positive where both happen to render the same
      // text for unrelated reasons: `extended`-only doctrine text must be
      // ABSENT from the resumed request, even though this second call's own
      // promptSnapshot() would have included it had it been used.
      expect(system2).not.toContain("Diagnosing a problem is not the same as fixing it");
    } finally {
      await closeServer(server);
    }
  });
});
