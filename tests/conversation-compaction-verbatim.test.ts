// Issue #584 (epic #575, P8): SUMMARY_SYSTEM's two verbatim sections are
// covered by text contract in tests/client-pool-aux.test.ts (where
// SUMMARY_SYSTEM was already imported and pinned by reference before this
// issue). This file covers the other three ACs -- proportional summary
// `maxTokens`, tail-truncation of the transcript handed to the summarizer,
// and the English `SUMMARY_LEAD_TEXT` rename staying backward-compatible
// with a session persisted before it. Lives in a NEW file (not
// tests/conversation-compaction.test.ts) only because #584's own `Files`
// glob (`tests/conversation-compaction*.test.ts`) allows it and
// tests/conversation-runtime.test.ts is pinned at exactly 800 lines -- the
// `contratos` CI check refuses any file over that, so no test for this
// issue could be added there either.
import { afterEach, describe, expect, it, vi } from "vitest";

import { SUMMARY_SYSTEM } from "../src/agent/aux.js";
import {
  attemptCompaction,
  buildSummaryRequest,
  buildTranscript,
  summaryMaxTokens,
  SUMMARY_MAX_TOKENS_CEILING,
  SUMMARY_MAX_TOKENS_FLOOR,
} from "../src/conversation/compaction.js";
import { openStateDatabase, SessionRepository, SUMMARY_LEAD_TEXT } from "../src/state/index.js";
import type { ConversationRepository } from "../src/conversation/types.js";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function turn(id: number): Readonly<Record<string, unknown>>[] {
  return [
    { role: "user", content: `question ${String(id)}` },
    { role: "assistant", content: `answer ${String(id)}`, finish_reason: "stop" },
  ];
}

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

describe("summaryMaxTokens (issue #584 AC: proportional maxTokens with a floor and ceiling)", () => {
  it("floors at 1024 for a small folded transcript", () => {
    expect(summaryMaxTokens(100)).toBe(SUMMARY_MAX_TOKENS_FLOOR);
  });

  it("scales proportionally (ceil(folded / 8)) for a mid-size folded transcript", () => {
    expect(summaryMaxTokens(16_000)).toBe(2000);
  });

  it("ceilings at 4096 for a very large folded transcript", () => {
    expect(summaryMaxTokens(1_000_000)).toBe(SUMMARY_MAX_TOKENS_CEILING);
  });

  it("never goes negative for a malformed (negative) estimate", () => {
    expect(summaryMaxTokens(-500)).toBe(SUMMARY_MAX_TOKENS_FLOOR);
  });
});

describe("buildSummaryRequest (issue #584): maxTokens follows the transcript's own size", () => {
  it("floors maxTokens at 1024 for a short transcript, same as before this issue", () => {
    const request = buildSummaryRequest({
      transcript: "short",
      model: "m",
      signal: new AbortController().signal,
    });
    expect(request.maxTokens).toBe(1024);
  });

  it("scales maxTokens up for a large folded transcript instead of staying pinned at 1024", () => {
    // 50_000 chars of prose -> 6 (message overhead) + ceil(50000 / 2.9) =
    // 17248 estimated tokens (src/context/token-estimate.ts's own factors)
    // -> ceil(17248 / 8) = 2156, comfortably between the floor and ceiling.
    const transcript = "x".repeat(50_000);
    const request = buildSummaryRequest({
      transcript,
      model: "m",
      signal: new AbortController().signal,
    });
    expect(request.maxTokens).toBe(2156);
    expect(request.maxTokens).toBeGreaterThan(1024);
  });

  it("still carries SUMMARY_SYSTEM, the transcript, the model and the signal unchanged", () => {
    const signal = new AbortController().signal;
    const request = buildSummaryRequest({ transcript: "t", model: "gpt", signal });
    expect(request.system).toBe(SUMMARY_SYSTEM);
    expect(request.model).toBe("gpt");
    expect(request.signal).toBe(signal);
    expect(request.messages).toEqual([{ role: "user", content: "t" }]);
    expect(request.tools).toEqual([]);
  });
});

describe("buildTranscript (issue #584 AC: tail truncation, never blowing the summary call's own budget)", () => {
  // Issue #620 (acréscimo do orquestrador, item 4): #587 removed the old
  // hardcoded `console.warn` here (TranscriptResult.truncated is the aviso
  // now, read by ConversationRuntime.preflightCompact through the injectable
  // eventSink) but the pin that buildTranscript never writes to the console
  // at all -- fitting OR truncating -- was dropped along with it. Reposto.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  afterEach(() => {
    warn.mockClear();
    error.mockClear();
  });

  it("returns the full transcript untouched, exactly as before this issue, when it fits the budget", () => {
    const messages = [...turn(1), ...turn(2)];
    const result = buildTranscript(messages, 1000);
    expect(result).toEqual({
      truncated: false,
      droppedMessages: 0,
      transcript: [
        "user: question 1",
        "assistant: answer 1",
        "user: question 2",
        "assistant: answer 2",
      ].join("\n\n"),
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("never truncates an empty transcript", () => {
    expect(buildTranscript([], 0)).toEqual({
      truncated: false,
      droppedMessages: 0,
      transcript: "",
    });
  });

  it("cuts from the tail at the nearest turn boundary once the transcript exceeds the budget, keeping the head (and an early prohibition in it) intact", () => {
    const messages = [...turn(1), ...turn(2), ...turn(3)];
    // turn(1) alone estimates at 19 tokens (6 + ceil(11/2.9) for "question 1",
    // then 6 + ceil(8/2.9) for "answer 1"); turn(2)'s first message would push
    // the running total to 29 -- a budget of 19 keeps exactly turn 1 and cuts
    // right before "question 2", a clean user-turn boundary (never splits a
    // request from its own reply, mirrors turnAlignedTailCount's own rule).
    const result = buildTranscript(messages, 19);
    expect(result.truncated).toBe(true);
    expect(result.droppedMessages).toBe(4);
    expect(result.transcript).toContain("user: question 1");
    expect(result.transcript).toContain("assistant: answer 1");
    expect(result.transcript).not.toContain("question 2");
    expect(result.transcript).not.toContain("question 3");
    expect(result.transcript).toMatch(/4 more recent folded message\(s\) omitted/);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("defaults to a budget derived from DEFAULT_CONTEXT_WINDOW when the caller passes none", () => {
    // An ordinary short transcript never trips the default budget.
    const result = buildTranscript([...turn(1)]);
    expect(result.truncated).toBe(false);
  });
});

describe("attemptCompaction threads maxTranscriptTokens through to buildTranscript (issue #584)", () => {
  it("truncates the folded transcript before summarizing it, and reports transcriptTruncated on the result", async () => {
    const history = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
    const summarize = vi.fn((transcript: string) => Promise.resolve(`recap of: ${transcript}`));
    const result = await attemptCompaction({
      repository: fakeRepository({
        acquireCompressionLock: () => true,
        releaseCompressionLock: () => true,
        compactHistory: () => ({ summarizedCount: 6, keptCount: 2 }),
        loadMessages: () => history,
      }),
      summarize,
      sessionId: "s",
      holder: "h",
      now: 1,
      lockTtlSeconds: 30,
      lockRetries: 3,
      lockRetryDelayMs: 0,
      sleep: () => Promise.resolve(),
      minKeepMessages: 2,
      maxTranscriptTokens: 19,
    });
    expect(result.compacted).toBe(true);
    expect(result.transcriptTruncated).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    const sentTranscript = summarize.mock.calls[0]?.[0] as string;
    expect(sentTranscript).toContain("question 1");
    expect(sentTranscript).not.toContain("question 2");
    expect(sentTranscript).toMatch(/more recent folded message\(s\) omitted/);
  });

  it("reports transcriptTruncated:false when the fold fits without cutting, same as before this issue", async () => {
    const history = [...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
    const summarize = vi.fn((transcript: string) => Promise.resolve(`recap of: ${transcript}`));
    const result = await attemptCompaction({
      repository: fakeRepository({
        acquireCompressionLock: () => true,
        releaseCompressionLock: () => true,
        compactHistory: () => ({ summarizedCount: 6, keptCount: 4 }),
        loadMessages: () => history,
      }),
      summarize,
      sessionId: "s",
      holder: "h",
      now: 1,
      lockTtlSeconds: 30,
      lockRetries: 3,
      lockRetryDelayMs: 0,
      sleep: () => Promise.resolve(),
      minKeepMessages: 4,
    });
    expect(result.transcriptTruncated).toBe(false);
  });

  it("reports transcriptTruncated:false on the futile (nothing to fold) path", async () => {
    const result = await attemptCompaction({
      repository: fakeRepository({
        acquireCompressionLock: () => true,
        releaseCompressionLock: () => true,
        compactHistory: () => ({ summarizedCount: 0, keptCount: 0 }),
        loadMessages: () => [...turn(1)],
      }),
      summarize: () => Promise.resolve("x"),
      sessionId: "s",
      holder: "h",
      now: 1,
      lockTtlSeconds: 30,
      lockRetries: 3,
      lockRetryDelayMs: 0,
      sleep: () => Promise.resolve(),
      minKeepMessages: 8,
    });
    expect(result).toMatchObject({ compacted: false, transcriptTruncated: false });
  });
});

describe("SUMMARY_LEAD_TEXT: English rename stays backward-compatible (issue #584 AC)", () => {
  it("pins the new English lead text", () => {
    expect(SUMMARY_LEAD_TEXT).toBe("(summary of the earlier conversation follows)");
  });

  it("keeps loading a session whose summary lead was persisted before the rename", () => {
    const OLD_LEAD_TEXT = "(resumo da conversa anterior a seguir)";
    // The rename itself: today's constant must differ from the old
    // Portuguese literal, otherwise this whole test would pass vacuously.
    expect(SUMMARY_LEAD_TEXT).not.toBe(OLD_LEAD_TEXT);

    const root = mkdtempSync(join(tmpdir(), "lohra-compaction-verbatim-"));
    try {
      const connection = openStateDatabase(join(root, "state.db"));
      try {
        const repo = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
        repo.createSession({ id: "s-old-lead", model: "m" });
        repo.appendMessage("s-old-lead", { role: "user", content: OLD_LEAD_TEXT, createdAt: 1 });
        repo.appendMessage("s-old-lead", {
          role: "assistant",
          content: "recap of an old session",
          createdAt: 2,
          finishReason: "stop",
        });
        expect(repo.loadMessages("s-old-lead")).toEqual([
          { role: "user", content: OLD_LEAD_TEXT },
          { role: "assistant", content: "recap of an old session", finish_reason: "stop" },
        ]);
      } finally {
        connection.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
