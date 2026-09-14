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

import { SqliteConversationRepository } from "../src/conversation/sqlite-repository.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";

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
