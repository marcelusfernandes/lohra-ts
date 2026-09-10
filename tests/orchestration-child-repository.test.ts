import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationRuntime,
  type ConversationRuntimeEvent,
  type ModelRequest,
  type ModelTransport,
} from "../src/conversation/index.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";
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

  // Issue #252 round 2 (revisor rejection on PR #284): before this fix,
  // ChildConversationRepository implemented ConversationRepository without
  // acquireCompressionLock/releaseCompressionLock/compactHistory --
  // attemptCompaction (src/conversation/compaction.ts) throws
  // CompactionUnsupportedError when any of the three is missing, so every
  // subagent turn (spawn_session/delegate_task, child-runner.ts) whose
  // history overflowed the window would fault where the parent's own
  // chat.ts route compacts and continues. See the describe block below for
  // the end-to-end regression test through a real ConversationRuntime.
  it("delegates acquireCompressionLock/releaseCompressionLock/compactHistory to the same underlying behavior as SqliteConversationRepository", () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const repo = new ChildConversationRepository(sessions, "parent-1");
    repo.createSession({ id: "child-1", systemPrompt: "SYS", model: "m", cwd: "/tmp" });
    repo.commitTurn({
      sessionId: "child-1",
      user: { role: "user", content: "q" },
      assistant: { role: "assistant", content: "a", finish_reason: "stop" },
      usage: null,
      cost: null,
      apiCalls: 1,
    });

    expect(repo.acquireCompressionLock("child-1", "h", 100, 30)).toBe(true);
    const result = repo.compactHistory("child-1", "h", 100, {
      keepTailCount: 0,
      summary: "recap",
    });
    expect(result.summarizedCount).toBe(2);
    expect(repo.releaseCompressionLock("child-1", "h")).toBe(true);
    close();
  });
});

function turn(id: number): Readonly<Record<string, unknown>>[] {
  return [
    { role: "user", content: `question ${String(id)} ${"x".repeat(2000)}` },
    {
      role: "assistant",
      content: `answer ${String(id)} ${"y".repeat(2000)}`,
      finish_reason: "stop",
    },
  ];
}

class QueueTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: readonly NormalizedResponse[]) {}

  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) throw new Error("TEST_RESPONSE_MISSING");
    return Promise.resolve(response);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const usage = {
  inputTokens: 11,
  outputTokens: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

describe("a real child turn through ConversationRuntime (issue #252 round 2)", () => {
  it("compacts an overflowing child history before the call, instead of faulting with CompactionUnsupportedError", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const repo = new ChildConversationRepository(sessions, "parent-1");
    repo.createSession({ id: "child-1", systemPrompt: "SUBAGENT_SYSTEM", model: "m", cwd: "/tmp" });
    for (let i = 0; i < 5; i += 1) {
      sessions.recordMessages("child-1", [
        { role: "user", content: (turn(i)[0] as { content: string }).content },
        {
          role: "assistant",
          content: (turn(i)[1] as { content: string }).content,
          finishReason: "stop",
        },
      ]);
    }

    const transport = new QueueTransport([
      {
        content: "recap",
        finishReason: "stop",
        toolCalls: [],
        reasoning: null,
        usage,
        providerData: null,
      },
      {
        content: "child turn done",
        finishReason: "stop",
        toolCalls: [],
        reasoning: null,
        usage,
        providerData: null,
      },
    ]);
    const events: ConversationRuntimeEvent[] = [];
    const runtime = new ConversationRuntime({
      repository: repo,
      transport,
      promptSnapshot: () => "SUBAGENT_SYSTEM",
      eventSink: (event) => events.push(event),
      idSource: () => "child-1",
      clock: () => 1000,
      environment: { LOHRA_CONTEXT_WINDOW: "2000" },
      minKeepMessages: 2,
    });

    const result = await runtime.runTurn({
      input: "overflow trigger",
      provider: "ollama",
      model: "m",
      cwd: "/tmp",
      sessionId: "child-1",
    });

    expect(result.response.content).toBe("child turn done");
    expect(result.compaction).not.toBeNull();
    expect(events.map((event) => event.type)).toContain("session.compacted");
    close();
  });
});
