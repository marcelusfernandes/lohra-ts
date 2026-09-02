import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import { ChildConversationRepository } from "../src/orchestration/child-repository.js";

const roots: string[] = [];

function setup(): { readonly sessions: SessionRepository; readonly close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lohra-child-repo-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  return {
    sessions: new SessionRepository(connection.database, () => 1000, connection.ftsEnabled),
    close: () => {
      connection.close();
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("ChildConversationRepository", () => {
  it("creates the session row with source='orchestration' and the given parent_session_id (contract L21)", () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const repo = new ChildConversationRepository(sessions, "parent-1");

    repo.createSession({
      id: "child-1",
      systemPrompt: "SUBAGENT_SYSTEM",
      model: "fake-model-a",
      cwd: "/tmp",
    });

    const row = sessions.getSession("child-1") as Readonly<Record<string, unknown>>;
    expect(row.source).toBe("orchestration");
    expect(row.parent_session_id).toBe("parent-1");
    expect(row.model).toBe("fake-model-a");
    close();
  });

  it("keeps the parent session invisible to listSessions, unaffected by child creation (L21)", () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const repo = new ChildConversationRepository(sessions, "parent-1");
    repo.createSession({ id: "child-1", systemPrompt: "X", model: "m", cwd: "/tmp" });

    const listed = sessions.listSessions().map((row) => row.id);
    expect(listed).toEqual(["parent-1"]); // the child is filtered out, source != 'orchestration'
    close();
  });

  it("delegates session/loadMessages/commitTurn/commitUsage/summary to the same underlying behavior as SqliteConversationRepository", () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const repo = new ChildConversationRepository(sessions, "parent-1");
    repo.createSession({ id: "child-1", systemPrompt: "SYS", model: "m", cwd: "/tmp" });

    expect(repo.session("child-1")).toEqual({ systemPrompt: "SYS", model: "m", cwd: "/tmp" });
    expect(repo.loadMessages("child-1")).toEqual([]);

    repo.commitTurn({
      sessionId: "child-1",
      user: { role: "user", content: "hi" },
      assistant: { role: "assistant", content: "hello", finish_reason: "stop" },
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      cost: null,
      apiCalls: 1,
    });

    expect(repo.loadMessages("child-1")).toHaveLength(2);
    expect(repo.summary("child-1")?.apiCallCount).toBe(1);
    close();
  });
});
