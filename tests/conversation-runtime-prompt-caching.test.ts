// Issue #586 (épico #575, 2ª rodada): `ConversationRuntime` reads whatever
// `promptSnapshot()` returns -- a plain string (every caller before this
// issue) or the full `SystemPromptSnapshot` (`{stable, context, volatile}`,
// now `chat.ts`/`dashboard.ts` for their own `ConversationRuntime`) -- and
// forwards it UNFLATTENED both to `ModelRequest.system` (so a transport that
// understands bands can mark its cache breakpoint) AND to
// `ConversationRepository.createSession` (so a repository that understands
// bands, `SqliteConversationRepository`, can persist the three columns
// instead of only the flattened text). Flattening is the REPOSITORY's job
// now, not runtime.ts's -- `tests/conversation-sqlite-prompt-caching.test.ts`
// proves the real one does it; this file proves runtime.ts never flattens on
// its own and never regresses a plain-string caller. Molded on
// `tests/conversation-runtime-forced-tool.test.ts`'s fake repository/
// transport shape; never touches that file or the capped
// `tests/conversation-runtime.test.ts`.
import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../src/context/index.js";
import { ConversationRuntime } from "../src/conversation/index.js";
import type {
  ConversationRepository,
  ModelRequest,
  ModelTransport,
  TurnCommit,
} from "../src/conversation/index.js";
import type { NormalizedResponse, SystemBands } from "../src/transports/index.js";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

class MemoryRepository implements ConversationRepository {
  readonly created: { readonly systemPrompt: string | SystemBands }[] = [];
  private readonly sessions = new Map<
    string,
    { systemPrompt: string | SystemBands; model: string; cwd: string }
  >();
  private readonly messages = new Map<string, Readonly<Record<string, unknown>>[]>();

  createSession(input: {
    readonly id: string;
    readonly systemPrompt: string | SystemBands;
    readonly model: string;
    readonly cwd: string;
  }): void {
    this.created.push({ systemPrompt: input.systemPrompt });
    this.sessions.set(input.id, {
      systemPrompt: input.systemPrompt,
      model: input.model,
      cwd: input.cwd,
    });
  }
  /** Issue #649: seeds a session directly, bypassing `createSession`, so a
   * test can simulate a RESUMED session — one `session()` already restored
   * from a prior process, with its own bands, independent of whatever this
   * runtime instance's own `promptSnapshot` would compute. */
  seed(id: string, session: { systemPrompt: string | SystemBands; model: string; cwd: string }) {
    this.sessions.set(id, session);
  }
  session(id: string) {
    return this.sessions.get(id) ?? null;
  }
  loadMessages(id: string): readonly Readonly<Record<string, unknown>>[] {
    return this.messages.get(id) ?? [];
  }
  commitTurn(commit: TurnCommit): void {
    this.messages.set(commit.sessionId, [...(commit.messages ?? [])]);
  }
  commitUsage(): void {
    // unused in this test
  }
  summary() {
    return null;
  }
}

class QueueTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      content: "ok",
      finishReason: "stop",
      toolCalls: [],
      reasoning: null,
      usage,
      providerData: null,
    });
  }
  close(): void {
    // no-op
  }
}

describe("ConversationRuntime prompt caching plumbing (#586)", () => {
  it("forwards the full SystemPromptSnapshot bands to the transport's ModelRequest.system unflattened", async () => {
    const snapshot = buildSystemPrompt({
      identity: "Soul",
      doctrine: "DOCTRINE",
      systemMessage: "caller",
      today: "2030-01-02",
    });
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport,
      promptSnapshot: () => snapshot,
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "anthropic", model: "m", cwd: "/tmp" });

    expect(transport.requests[0]?.system).toMatchObject({
      stable: snapshot.stable,
      context: snapshot.context,
      volatile: snapshot.volatile,
    });
  });

  it("passes the bands to createSession unflattened — a repository that understands them decides what to persist", async () => {
    const snapshot = buildSystemPrompt({
      identity: "Soul",
      doctrine: "DOCTRINE",
      today: "2030-01-02",
    });
    const repository = new MemoryRepository();
    const runtime = new ConversationRuntime({
      repository,
      transport: new QueueTransport(),
      promptSnapshot: () => snapshot,
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "anthropic", model: "m", cwd: "/tmp" });

    expect(repository.created).toHaveLength(1);
    expect(repository.created[0]?.systemPrompt).toMatchObject({
      stable: snapshot.stable,
      context: snapshot.context,
      volatile: snapshot.volatile,
    });
  });

  it("keeps a plain-string promptSnapshot byte-identical — every caller before this issue is unaffected", async () => {
    const transport = new QueueTransport();
    const repository = new MemoryRepository();
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "FLAT SYSTEM TEXT",
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "anthropic", model: "m", cwd: "/tmp" });

    expect(transport.requests[0]?.system).toBe("FLAT SYSTEM TEXT");
    expect(repository.created[0]?.systemPrompt).toBe("FLAT SYSTEM TEXT");
  });
});

// Issue #649 (sub-issue B1 de #637): sessão RETOMADA usa as faixas
// persistidas pelo repositório, byte-idênticas, em vez de descartá-las e
// recomputar via `promptSnapshot()` — é o mesmo mecanismo do item 10 do
// veredito da PR #610 visto do outro lado: a RECONSTRUÇÃO é que viola o
// invariante 1 (CLAUDE.md), não a ausência de doutrina numa sessão que
// nasceu sem ela.
describe("ConversationRuntime reuses restored session bands on resume (#649)", () => {
  it("forwards the RESTORED bands (A) to the transport, never this process's own promptSnapshot() (B), when the resumed session understood bands (volatile not empty)", async () => {
    const bandsA: SystemBands = {
      stable: "STABLE A (persisted)",
      context: "CONTEXT A (persisted)",
      volatile: "Today's date is 2020-01-01 (persisted).",
    };
    const bandsB: SystemBands = {
      stable: "STABLE B (this process's own promptSnapshot)",
      context: "CONTEXT B",
      volatile: "Today's date is 2099-12-31 (this process).",
    };
    const repository = new MemoryRepository();
    repository.seed("s1", { systemPrompt: bandsA, model: "m", cwd: "/tmp" });
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => bandsB,
      idSource: () => "unused",
      clock: () => 1000,
    });

    await runtime.runTurn({
      input: "hi",
      provider: "anthropic",
      model: "m",
      cwd: "/tmp",
      sessionId: "s1",
    });

    expect(transport.requests[0]?.system).toEqual(bandsA);
  });

  it("falls back to promptSnapshot() for a migrated session (context and volatile both empty) — no false positive on the volatile discriminator", async () => {
    const migratedBands: SystemBands = { stable: "OLD FLAT PROMPT", context: "", volatile: "" };
    const freshSnapshot: SystemBands = {
      stable: "FRESH STABLE",
      context: "FRESH CONTEXT",
      volatile: "Today's date is 2030-06-15.",
    };
    const repository = new MemoryRepository();
    repository.seed("s1", { systemPrompt: migratedBands, model: "m", cwd: "/tmp" });
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => freshSnapshot,
      idSource: () => "unused",
      clock: () => 1000,
    });

    await runtime.runTurn({
      input: "hi",
      provider: "anthropic",
      model: "m",
      cwd: "/tmp",
      sessionId: "s1",
    });

    expect(transport.requests[0]?.system).toEqual(freshSnapshot);
  });

  it("a brand-new session is unaffected — still promptSnapshot() + createSession with the three bands", async () => {
    const snapshot: SystemBands = {
      stable: "STABLE NEW",
      context: "CONTEXT NEW",
      volatile: "Today's date is 2030-01-02.",
    };
    const repository = new MemoryRepository();
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => snapshot,
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "anthropic", model: "m", cwd: "/tmp" });

    expect(transport.requests[0]?.system).toEqual(snapshot);
    expect(repository.created[0]?.systemPrompt).toEqual(snapshot);
  });
});
