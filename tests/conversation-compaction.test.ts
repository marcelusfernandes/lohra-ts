import { describe, expect, it, vi } from "vitest";

import {
  attemptCompaction,
  buildSummaryMessage,
  compactionThreshold,
  resolveTurnContextWindow,
  turnAlignedTailCount,
  DEFAULT_MIN_KEEP_MESSAGES,
} from "../src/conversation/compaction.js";
import {
  CompactionFailedError,
  CompactionUnsupportedError,
  CompressionLockBusyError,
} from "../src/conversation/errors.js";
import type { CompactionResult, ConversationRepository } from "../src/conversation/types.js";

function turn(id: number): Readonly<Record<string, unknown>>[] {
  return [
    { role: "user", content: `question ${String(id)}` },
    { role: "assistant", content: `answer ${String(id)}`, finish_reason: "stop" },
  ];
}

describe("turnAlignedTailCount", () => {
  it("keeps at least minKeep messages, landing on the nearest user boundary", () => {
    const messages = [...turn(1), ...turn(2), ...turn(3)];
    // minKeep=3 would land mid-turn (index 3, an assistant message) --
    // the function must walk back to the nearest user boundary (index 2).
    expect(turnAlignedTailCount(messages, 3)).toBe(4);
  });

  it("returns everything when minKeep already covers the whole history", () => {
    const messages = [...turn(1)];
    expect(turnAlignedTailCount(messages, 10)).toBe(2);
  });

  it("returns everything when no user boundary exists before minKeep", () => {
    const messages = [{ role: "assistant", content: "orphan" }];
    expect(turnAlignedTailCount(messages, 0)).toBe(1);
  });

  it("never separates a tool_calls message from its tool results", () => {
    const messages = [
      ...turn(1),
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        finish_reason: "tool_calls",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "assistant", content: "done", finish_reason: "stop" },
    ];
    // minKeep=2 would land inside the tool_calls/tool_result pair (index 5)
    // -- must walk back to the user message that starts that turn (index 2).
    const kept = turnAlignedTailCount(messages, 2);
    expect(messages[messages.length - kept]).toMatchObject({ role: "user", content: "do it" });
  });

  it("is pure (never mutates its input)", () => {
    const messages = [...turn(1), ...turn(2)];
    const before = structuredClone(messages);
    turnAlignedTailCount(messages, 1);
    expect(messages).toEqual(before);
  });
});

describe("compactionThreshold", () => {
  it("reserves more of the window when the source is an estimate, not a measurement", () => {
    const measured = compactionThreshold({ window: 100_000, source: "table", maxTokens: 0 });
    const estimated = compactionThreshold({ window: 100_000, source: "provider", maxTokens: 0 });
    const guessed = compactionThreshold({ window: 100_000, source: "default", maxTokens: 0 });
    expect(estimated).toBeLessThan(measured);
    expect(guessed).toBeLessThan(measured);
  });

  it("subtracts maxTokens beyond the margin", () => {
    const noOutput = compactionThreshold({ window: 100_000, source: "table", maxTokens: 0 });
    const withOutput = compactionThreshold({ window: 100_000, source: "table", maxTokens: 8000 });
    expect(withOutput).toBe(noOutput - 8000);
  });
});

describe("resolveTurnContextWindow", () => {
  it("honors LOHRA_CONTEXT_WINDOW as the top-precedence override", () => {
    const resolution = resolveTurnContextWindow({
      provider: "ollama",
      model: "llama3",
      environment: { LOHRA_CONTEXT_WINDOW: "4000" },
    });
    expect(resolution).toEqual({ tokens: 4000, source: "override" });
  });

  it("falls back to the provider's floor for a known provider without a table entry", () => {
    const resolution = resolveTurnContextWindow({
      provider: "openai-codex",
      model: "some-future-model",
      environment: {},
    });
    expect(resolution).toEqual({ tokens: 1_050_000, source: "provider" });
  });

  it("falls back to the global default for an unrecognized provider name", () => {
    const resolution = resolveTurnContextWindow({
      provider: "not-a-real-provider",
      model: "m",
      environment: {},
    });
    expect(resolution).toEqual({ tokens: 200_000, source: "default" });
  });
});

describe("buildSummaryMessage", () => {
  it("is an assistant message, never a system message", () => {
    // Anthropic/Responses transports fold role:"system" inside `messages`
    // into the top-level system field -- that would corrupt the frozen
    // system prompt (invariant 1). Assistant survives every transport.
    expect(buildSummaryMessage("recap").role).toBe("assistant");
  });
});

function fakeRepository(overrides: Partial<ConversationRepository> = {}): ConversationRepository {
  return {
    createSession: () => undefined,
    session: () => null,
    loadMessages: () => [],
    commitTurn: () => undefined,
    commitUsage: () => undefined,
    summary: () => null,
    ...overrides,
  };
}

describe("attemptCompaction", () => {
  const sleep = () => Promise.resolve();

  it("throws CompactionUnsupportedError when the repository has no compaction methods", async () => {
    await expect(
      attemptCompaction({
        repository: fakeRepository(),
        summarize: () => Promise.resolve("x"),
        sessionId: "s",
        holder: "h",
        now: 1,
        lockTtlSeconds: 30,
        lockRetries: 3,
        lockRetryDelayMs: 0,
        sleep,
        minKeepMessages: DEFAULT_MIN_KEEP_MESSAGES,
      }),
    ).rejects.toBeInstanceOf(CompactionUnsupportedError);
  });

  it("retries a bounded number of times and throws CompressionLockBusyError if it never acquires", async () => {
    const acquire = vi.fn(() => false);
    await expect(
      attemptCompaction({
        repository: fakeRepository({
          acquireCompressionLock: acquire,
          releaseCompressionLock: () => true,
          compactHistory: () => ({ summarizedCount: 0, keptCount: 0 }) satisfies CompactionResult,
        }),
        summarize: () => Promise.resolve("x"),
        sessionId: "s",
        holder: "h",
        now: 1,
        lockTtlSeconds: 30,
        lockRetries: 3,
        lockRetryDelayMs: 0,
        sleep,
        minKeepMessages: DEFAULT_MIN_KEEP_MESSAGES,
      }),
    ).rejects.toBeInstanceOf(CompressionLockBusyError);
    expect(acquire).toHaveBeenCalledTimes(3);
  });

  it("returns compacted:false without writing when there is nothing left to fold", async () => {
    const release = vi.fn(() => true);
    const compactHistory = vi.fn();
    const result = await attemptCompaction({
      repository: fakeRepository({
        acquireCompressionLock: () => true,
        releaseCompressionLock: release,
        compactHistory,
        loadMessages: () => [...turn(1)], // shorter than minKeepMessages
      }),
      summarize: () => Promise.resolve("x"),
      sessionId: "s",
      holder: "h",
      now: 1,
      lockTtlSeconds: 30,
      lockRetries: 3,
      lockRetryDelayMs: 0,
      sleep,
      minKeepMessages: DEFAULT_MIN_KEEP_MESSAGES,
    });
    expect(result).toMatchObject({ compacted: false, summarizedCount: 0 });
    expect(compactHistory).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("s", "h");
  });

  it("wraps a summarizer failure in CompactionFailedError and still releases the lock", async () => {
    const release = vi.fn(() => true);
    const history = [...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
    await expect(
      attemptCompaction({
        repository: fakeRepository({
          acquireCompressionLock: () => true,
          releaseCompressionLock: release,
          compactHistory: () => ({ summarizedCount: 2, keptCount: 8 }),
          loadMessages: () => history,
        }),
        summarize: () => Promise.reject(new Error("provider down")),
        sessionId: "s",
        holder: "h",
        now: 1,
        lockTtlSeconds: 30,
        lockRetries: 3,
        lockRetryDelayMs: 0,
        sleep,
        minKeepMessages: 4,
      }),
    ).rejects.toBeInstanceOf(CompactionFailedError);
    expect(release).toHaveBeenCalledWith("s", "h");
  });

  it("summarizes the folded prefix, rewrites, and returns the fresh history", async () => {
    const history = [...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
    const compactedHistory = [buildSummaryMessage("recap"), ...turn(4), ...turn(5)];
    const summarize = vi.fn((transcript: string) => Promise.resolve(`recap of: ${transcript}`));
    const compactHistory = vi.fn(
      () => ({ summarizedCount: 6, keptCount: 4 }) satisfies CompactionResult,
    );
    let loadCount = 0;
    const result = await attemptCompaction({
      repository: fakeRepository({
        acquireCompressionLock: () => true,
        releaseCompressionLock: () => true,
        compactHistory,
        loadMessages: () => {
          loadCount += 1;
          return loadCount === 1 ? history : compactedHistory;
        },
      }),
      summarize,
      sessionId: "s",
      holder: "h",
      now: 1,
      lockTtlSeconds: 30,
      lockRetries: 3,
      lockRetryDelayMs: 0,
      sleep,
      minKeepMessages: 4,
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    const expectedTranscript = [
      "user: question 1",
      "assistant: answer 1",
      "user: question 2",
      "assistant: answer 2",
      "user: question 3",
      "assistant: answer 3",
    ].join("\n\n");
    expect(compactHistory).toHaveBeenCalledWith("s", "h", 1, {
      keepTailCount: 4,
      summary: `recap of: ${expectedTranscript}`,
    });
    expect(result).toEqual({
      compacted: true,
      summarizedCount: 6,
      keptCount: 4,
      history: compactedHistory,
    });
  });
});
