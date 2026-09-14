// Issue #586 (épico #575, 2ª rodada): `SqliteConversationRepository` -- a
// thin wrapper `chat.ts`/`dashboard.ts` construct straight over a real
// `SessionRepository`/SQLite connection -- persists and restores the three
// prompt-caching bands, not just the flattened `system_prompt` it always
// wrote before this issue. No dedicated unit test existed for this wrapper
// before this issue (only indirect coverage through
// `tests/gateway-compaction-events.test.ts`/`tests/orchestration-child-
// repository.test.ts`, both fixtures on the OLD flattened-string shape and
// out of this issue's `Files`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildSystemPrompt, doctrineText } from "../src/context/index.js";
import { ConversationRuntime } from "../src/conversation/index.js";
import type { ModelRequest, ModelTransport } from "../src/conversation/index.js";
import { SqliteConversationRepository } from "../src/conversation/sqlite-repository.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";

const roots: string[] = [];

function repository(): { readonly repo: SqliteConversationRepository; readonly close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lohra-sqlite-repo-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
  return {
    repo: new SqliteConversationRepository(sessions),
    close: () => {
      connection.close();
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("SqliteConversationRepository prompt caching bands (#586)", () => {
  it("persists the three bands via createSession and restores them via session()", () => {
    const { repo, close } = repository();
    const bands = { stable: "STABLE", context: "CONTEXT", volatile: "VOLATILE" };
    repo.createSession({ id: "s1", systemPrompt: bands, model: "m", cwd: "/tmp" });

    const stored = repo.session("s1");
    expect(stored).toEqual({ systemPrompt: bands, model: "m", cwd: "/tmp" });
    close();
  });

  it("reconstructs stable+context byte-identical to what was written (the cache-relevant prefix)", () => {
    const { repo, close } = repository();
    const bands = {
      stable: "IDENTITY\n\nDOCTRINE",
      context: "PROJECT INSTRUCTIONS",
      volatile: "Today's date is 2030-01-02.",
    };
    repo.createSession({ id: "s1", systemPrompt: bands, model: "m", cwd: "/tmp" });

    const restored = repo.session("s1");
    const restoredSystemPrompt = restored?.systemPrompt;
    const restoredPrefix =
      typeof restoredSystemPrompt === "string"
        ? restoredSystemPrompt
        : `${restoredSystemPrompt?.stable ?? ""}\n\n${restoredSystemPrompt?.context ?? ""}`;
    expect(restoredPrefix).toBe(`${bands.stable}\n\n${bands.context}`);
    close();
  });

  it("migrates a plain-string createSession into the whole stable band on restore", () => {
    const { repo, close } = repository();
    repo.createSession({ id: "s1", systemPrompt: "FLAT TEXT", model: "m", cwd: "/tmp" });

    expect(repo.session("s1")).toEqual({
      systemPrompt: { stable: "FLAT TEXT", context: "", volatile: "" },
      model: "m",
      cwd: "/tmp",
    });
    close();
  });

  it("migrates a row written before this issue (only system_prompt, no band columns)", () => {
    // Direct SessionRepository.createSession call with a bare string,
    // exactly like every session created before this issue's columns
    // existed -- the SqliteConversationRepository layer never touched the
    // write path directly for this row.
    const root = mkdtempSync(join(tmpdir(), "lohra-sqlite-repo-old-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    connection.database
      .prepare(
        `INSERT INTO sessions (id, source, system_prompt, model, cwd, started_at)
                VALUES ('old', 'cli', 'OLD FLAT PROMPT', 'm', '/tmp', 5)`,
      )
      .run();
    const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
    const oldRepo = new SqliteConversationRepository(sessions);

    expect(oldRepo.session("old")).toEqual({
      systemPrompt: { stable: "OLD FLAT PROMPT", context: "", volatile: "" },
      model: "m",
      cwd: "/tmp",
    });
    connection.close();
  });

  it("returns null for a session that doesn't exist", () => {
    const { repo, close } = repository();
    expect(repo.session("missing")).toBeNull();
    close();
  });
});

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

/** A second `ConversationRuntime` over the SAME `SqliteConversationRepository`
 * simulates a second PROCESS resuming the session — each instance memoizes
 * its own `promptSnapshot()` independently (`runtime.ts:153-156`), exactly
 * like two real `chat --session` invocations. */
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

// Issue #649 (sub-issue B1 de #637, AC3): a sessão retomada num SEGUNDO
// ConversationRuntime (processo novo) usa o prompt P1 que a sessão
// persistiu quando nasceu, byte-idêntico, mesmo que este segundo processo
// tivesse computado um prompt P2 diferente (memória nova, doutrina
// diferente, data diferente). Pino explícito das três consequências
// nomeadas em `docs/decisions/2026-09-14-faixas-restauradas.md`: a data
// congelada é a de P1 (a), e a doutrina de P1 (core, "sem doutrina") vence
// mesmo com P2 disponível trazendo a doutrina extended (item 10 do veredito
// da PR #610 fecha por construção).
describe("ConversationRuntime resumed across two processes reuses P1 (#649)", () => {
  it("a second ConversationRuntime resuming the session uses P1's bands (date and doctrine), never this process's own P2", async () => {
    const { repo, close } = repository();
    const p1 = buildSystemPrompt({
      identity: "Soul",
      doctrine: doctrineText("core"),
      today: "2030-01-01",
    });
    const p2 = buildSystemPrompt({
      identity: "Soul",
      doctrine: doctrineText("extended"),
      today: "2031-02-02",
    });

    const runtime1 = new ConversationRuntime({
      repository: repo,
      transport: new QueueTransport(),
      promptSnapshot: () => p1,
      idSource: () => "fixed-session",
      clock: () => 1,
    });
    await runtime1.runTurn({ input: "hi", provider: "p", model: "m", cwd: "/tmp" });

    const transport2 = new QueueTransport();
    const runtime2 = new ConversationRuntime({
      repository: repo,
      transport: transport2,
      promptSnapshot: () => p2,
      idSource: () => {
        throw new Error("idSource must not be called — sessionId is explicit");
      },
      clock: () => 2,
    });
    await runtime2.runTurn({
      input: "hi again",
      provider: "p",
      model: "m",
      cwd: "/tmp",
      sessionId: "fixed-session",
    });

    const resumedSystem = transport2.requests[0]?.system;
    // `resumedSystem` round-tripped through SQLite: a plain
    // `{stable, context, volatile}`, not the `SystemPromptSnapshot` class
    // instance `p1` is (`.text` is a getter, own-enumerable comparison would
    // otherwise flag a shape difference that isn't a behavior difference).
    expect(resumedSystem).toEqual({
      stable: p1.stable,
      context: p1.context,
      volatile: p1.volatile,
    });
    const resumedText = JSON.stringify(resumedSystem);
    // (a) the frozen date is P1's, not this process's own P2.
    expect(resumedText).toContain("2030-01-01");
    expect(resumedText).not.toContain("2031-02-02");
    // (item 10) P1 was created with core-only doctrine; P2's extended-only
    // text never reaches the resumed turn even though it's available here.
    expect(resumedText).not.toContain("Diagnosing a problem is not the same as fixing it");

    close();
  });
});
