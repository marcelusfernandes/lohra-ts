import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, SessionRepository, StateError } from "../src/state/index.js";

const roots: string[] = [];

function repository(): {
  readonly repo: SessionRepository;
  readonly close: () => void;
  readonly database: import("better-sqlite3").Database;
} {
  const root = mkdtempSync(join(tmpdir(), "lohra-state-repo-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  return {
    repo: new SessionRepository(connection.database, () => 1000, connection.ftsEnabled),
    close: () => {
      connection.close();
    },
    database: connection.database,
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("session repository", () => {
  it("round-trips role-aware messages and stores Python-spaced JSON bytes", () => {
    const { repo, database, close } = repository();
    repo.createSession({ id: "s1", model: "m", startedAt: 10 });
    repo.appendMessage("s1", { role: "user", content: "hello stub world", createdAt: 11 });
    repo.appendMessage("s1", {
      role: "assistant",
      content: null,
      finishReason: "tool_calls",
      createdAt: 12,
      toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a": 1}' } }],
      providerData: { z: 2, a: 1 },
    });
    repo.appendMessage("s1", {
      role: "tool",
      name: "f",
      toolCallId: "c1",
      content: "ok",
      createdAt: 13,
    });

    const stored = database
      .prepare(
        "SELECT tool_calls, reasoning_details, typeof(timestamp) AS timestamp_type FROM messages WHERE id = 2",
      )
      .get() as Record<string, unknown>;
    expect(stored.tool_calls).toBe(
      '[{"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{\\"a\\": 1}"}}]',
    );
    expect(stored.reasoning_details).toBe('{"z": 2, "a": 1}');
    expect(stored.timestamp_type).toBe("real");
    expect(repo.loadMessages("s1")).toEqual([
      { role: "user", content: "hello stub world" },
      {
        role: "assistant",
        content: "",
        finish_reason: "tool_calls",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: '{"a": 1}' } },
        ],
        provider_data: { z: 2, a: 1 },
      },
      { role: "tool", name: "f", tool_call_id: "c1", content: "ok" },
    ]);
    close();
  });

  it("accumulates usage while preserving integral REAL storage", () => {
    const { repo, database, close } = repository();
    repo.createSession({ id: "usage", startedAt: 20 });
    repo.addUsage("usage", {
      inputTokens: 11,
      outputTokens: 7,
      apiCalls: 2,
      realUsd: 0,
      grossUsd: 0.5,
    });
    repo.addUsage("usage", { inputTokens: 1, outputTokens: 1, apiCalls: 1 });
    expect(repo.usage("usage")).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiCallCount: 3,
      pricedCallCount: 2,
      actualCostUsd: 0,
      estimatedCostUsd: 0.5,
    });
    expect(
      database
        .prepare(
          "SELECT typeof(actual_cost_usd) AS actual, typeof(api_call_count) AS calls FROM sessions WHERE id = 'usage'",
        )
        .get(),
    ).toEqual({ actual: "real", calls: "integer" });
    close();
  });

  it("keeps archived and orchestration filters independent", () => {
    const { repo, database, close } = repository();
    repo.createSession({ id: "s1", source: "cli", startedAt: 3 });
    repo.createSession({ id: "s-arch", source: "cli", startedAt: 2 });
    repo.createSession({ id: "s-orch", source: "orchestration", startedAt: 1 });
    database.prepare("UPDATE sessions SET archived = 1 WHERE id = 's-arch'").run();
    expect(repo.listSessions().map((row) => row.id)).toEqual(["s1"]);
    expect(repo.listSessions({ includeArchived: true }).map((row) => row.id)).toEqual([
      "s1",
      "s-arch",
    ]);
    close();
  });

  it("caps lineage at the nearest 100 and handles FTS hit, blank, and malformed", () => {
    const { repo, close } = repository();
    let parent: string | null = null;
    for (let index = 0; index < 105; index += 1) {
      const id = `lin-${index.toString().padStart(4, "0")}`;
      repo.createSession({ id, parentSessionId: parent, startedAt: index });
      parent = id;
    }
    expect(repo.lineageRootToTip("lin-0104")).toHaveLength(100);
    expect(repo.lineageRootToTip("lin-0104").at(0)).toBe("lin-0005");
    expect(repo.lineageRootToTip("lin-0104").at(-1)).toBe("lin-0104");
    repo.appendMessage("lin-0104", {
      role: "user",
      content: "hello stub world",
      createdAt: 200,
    });
    expect(repo.searchMessages("hello stub").map((row) => row.snippet)).toEqual([
      "[hello] [stub] world  ",
    ]);
    expect(repo.searchMessages("   ")).toEqual([]);
    expect(repo.searchMessages("AND OR (( NEAR")).toEqual([]);
    close();
  });

  it("fails closed when an INTEGER cannot be represented safely", () => {
    const { repo, database, close } = repository();
    repo.createSession({ id: "unsafe", startedAt: 1 });
    database
      .prepare(
        "UPDATE sessions SET input_tokens = CAST('9007199254740993' AS INTEGER) WHERE id = 'unsafe'",
      )
      .run();
    try {
      repo.usage("unsafe");
      throw new Error("unsafe integer unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(StateError);
      expect((error as StateError).code).toBe("SQLITE_INTEGER_UNSAFE");
    }
    close();
  });

  it("rolls back both messages and usage when the assistant insert fails", () => {
    const { repo, database, close } = repository();
    repo.createSession({ id: "atomic", startedAt: 1 });
    database
      .prepare(
        `CREATE TRIGGER reject_assistant BEFORE INSERT ON messages
         WHEN NEW.role = 'assistant'
         BEGIN SELECT RAISE(ABORT, 'assistant rejected'); END`,
      )
      .run();

    expect(() => {
      repo.recordTurn("atomic", {
        user: { role: "user", content: "u" },
        assistant: { role: "assistant", content: "a" },
        usage: { inputTokens: 11, outputTokens: 7, apiCalls: 1, realUsd: 0, grossUsd: 0 },
      });
    }).toThrow("assistant rejected");
    expect(database.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0n });
    expect(repo.usage("atomic")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiCallCount: 0,
      pricedCallCount: null,
      actualCostUsd: null,
      estimatedCostUsd: null,
    });
    close();
  });
});
