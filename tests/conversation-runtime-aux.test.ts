// Issue #587 (epic #575, P11): proves the three runtime-level pieces of the
// "Acréscimo do orquestrador" that live in `src/conversation/runtime.ts`
// (never `tests/conversation-runtime.test.ts` — #584's own 800-line file,
// out of this issue's reach). Fake repository/transport shapes lifted from
// that file's own `CompactingMemoryRepository`/`QueueTransport`.
//
//   1. `maxTranscriptTokens` derived from the turn's REAL resolved window
//      (`LOHRA_CONTEXT_WINDOW`), not compaction.ts's own inert 100k default.
//   3. `transcriptTruncated` gets a real consumer: the
//      "compaction.transcript_truncated" event.
//   AC "Falha do auxiliar cai para o transporte do turno com evento
//   compaction.aux_fallback": an injected `options.summarize` that throws
//   falls open to the default summarizer, names the cause.
import { describe, expect, it, vi } from "vitest";

import { ConversationRuntime } from "../src/conversation/index.js";
import type {
  ConversationRepository,
  ConversationRuntimeEvent,
  ModelRequest,
  ModelTransport,
  TurnCommit,
} from "../src/conversation/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

class CompactingMemoryRepository implements ConversationRepository {
  private readonly sessions = new Map<
    string,
    { systemPrompt: string; model: string; cwd: string }
  >();
  messages = new Map<string, Readonly<Record<string, unknown>>[]>();
  private readonly locks = new Map<
    string,
    { readonly holder: string; readonly expiresAt: number }
  >();
  readonly compactCalls: { readonly summary: string }[] = [];

  createSession(input: {
    readonly id: string;
    readonly systemPrompt: string;
    readonly model: string;
    readonly cwd: string;
  }): void {
    this.sessions.set(input.id, {
      systemPrompt: input.systemPrompt,
      model: input.model,
      cwd: input.cwd,
    });
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
  acquireCompressionLock(sessionId: string, holder: string, now: number, ttl: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing !== undefined && existing.expiresAt > now && existing.holder !== holder) {
      return false;
    }
    this.locks.set(sessionId, { holder, expiresAt: now + ttl });
    return true;
  }
  releaseCompressionLock(sessionId: string, holder: string): boolean {
    const existing = this.locks.get(sessionId);
    if (existing?.holder !== holder) return false;
    this.locks.delete(sessionId);
    return true;
  }
  compactHistory(
    sessionId: string,
    _holder: string,
    _now: number,
    input: { readonly keepTailCount: number; readonly summary: string },
  ) {
    this.compactCalls.push({ summary: input.summary });
    const current = this.messages.get(sessionId) ?? [];
    const keepCount = Math.min(Math.max(0, input.keepTailCount), current.length);
    const summarizedCount = current.length - keepCount;
    if (summarizedCount <= 0) return { summarizedCount: 0, keptCount: current.length };
    const kept = current.slice(summarizedCount);
    const leadMessage = { role: "user", content: "(summary of the earlier conversation follows)" };
    const summaryMessage = { role: "assistant", content: input.summary, finish_reason: "stop" };
    this.messages.set(sessionId, [leadMessage, summaryMessage, ...kept]);
    return { summarizedCount, keptCount: kept.length };
  }
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

const response = (overrides: Partial<NormalizedResponse> = {}): NormalizedResponse => ({
  content: "STUB-OK",
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage,
  providerData: null,
  ...overrides,
});

function longTurn(id: number): Readonly<Record<string, unknown>>[] {
  return [
    { role: "user", content: `q${String(id)} ${"x".repeat(2000)}` },
    { role: "assistant", content: `a${String(id)} ${"y".repeat(2000)}`, finish_reason: "stop" },
  ];
}

describe("ConversationRuntime — transcript budget threads the real window (issue #587 item 1/3)", () => {
  it("derives maxTranscriptTokens from LOHRA_CONTEXT_WINDOW and emits compaction.transcript_truncated when it cuts", async () => {
    const repository = new CompactingMemoryRepository();
    repository.createSession({ id: "s", systemPrompt: "sys", model: "m", cwd: "/tmp" });
    // 20 big turns: with a real window of 2000 (maxTranscriptTokens ~1000,
    // TRANSCRIPT_WINDOW_FRACTION=0.5), the folded prefix blows well past
    // 1000 tokens -- the OLD inert 100k-token compaction.ts default would
    // never have truncated a fixture this small.
    repository.messages.set("s", Array.from({ length: 20 }, (_, i) => longTurn(i)).flat());

    let receivedTranscript = "";
    const summarize = vi.fn((transcript: string) => {
      receivedTranscript = transcript;
      return Promise.resolve("recap");
    });
    const transport = new QueueTransport([response({ content: "final answer" })]);
    const events: ConversationRuntimeEvent[] = [];
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "system prompt",
      eventSink: (event) => events.push(event),
      idSource: () => "s",
      clock: () => 1000,
      environment: { LOHRA_CONTEXT_WINDOW: "2000" },
      minKeepMessages: 2,
      summarize,
    });

    const result = await runtime.runTurn({
      input: "next question",
      provider: "ollama",
      model: "m",
      cwd: "/tmp",
      sessionId: "s",
    });

    expect(result.response.content).toBe("final answer");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(receivedTranscript).toContain("more recent folded message(s) omitted");
    expect(events.map((event) => event.type)).toContain("compaction.transcript_truncated");
  });

  it("never emits compaction.transcript_truncated when the folded prefix fits the real window", async () => {
    const repository = new CompactingMemoryRepository();
    repository.createSession({ id: "s", systemPrompt: "sys", model: "m", cwd: "/tmp" });
    // A modest first turn (what gets folded, with minKeepMessages=4 below
    // keeping the other two turns intact) plus two big-but-not-huge turns
    // (kept tail, never folded) -- sized so the TOTAL trips the preflight
    // threshold (~1840 of the forced 2000-token window), but folding just
    // the first turn away drops the estimate back under it (the summary
    // pair is far smaller than what it replaces), and the folded content
    // ALONE (~500 tokens) stays far under maxTranscriptTokens (~1000, half
    // the window): proves truncation tracks the folded content, not just
    // the overall estimate.
    const foldedTurn: Readonly<Record<string, unknown>>[] = [
      { role: "user", content: `q0 ${"x".repeat(700)}` },
      { role: "assistant", content: `a0 ${"y".repeat(700)}`, finish_reason: "stop" },
    ];
    const keptTurn = (id: number): Readonly<Record<string, unknown>>[] => [
      { role: "user", content: `q${String(id)} ${"x".repeat(1000)}` },
      { role: "assistant", content: `a${String(id)} ${"y".repeat(1000)}`, finish_reason: "stop" },
    ];
    repository.messages.set("s", [...foldedTurn, ...keptTurn(1), ...keptTurn(2)]);

    const summarize = vi.fn(() => Promise.resolve("recap"));
    const transport = new QueueTransport([response({ content: "final answer" })]);
    const events: ConversationRuntimeEvent[] = [];
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "system prompt",
      eventSink: (event) => events.push(event),
      idSource: () => "s",
      clock: () => 1000,
      environment: { LOHRA_CONTEXT_WINDOW: "2000" },
      minKeepMessages: 4,
      summarize,
    });

    await runtime.runTurn({
      input: "next question",
      provider: "ollama",
      model: "m",
      cwd: "/tmp",
      sessionId: "s",
    });

    expect(summarize).toHaveBeenCalledTimes(1); // proves a compaction ran at all
    expect(repository.compactCalls[0]?.summary).toBe("recap");
    expect(events.map((event) => event.type)).not.toContain("compaction.transcript_truncated");
  });
});

describe("ConversationRuntime — aux summarizer fallback (issue #587 AC)", () => {
  it("falls open to the default summarizer and emits compaction.aux_fallback when the injected summarize throws", async () => {
    const repository = new CompactingMemoryRepository();
    repository.createSession({ id: "s", systemPrompt: "sys", model: "m", cwd: "/tmp" });
    repository.messages.set("s", Array.from({ length: 10 }, (_, i) => longTurn(i)).flat());

    const auxFailure = new Error("aux provider down");
    const summarize = vi.fn(() => Promise.reject(auxFailure));
    const transport = new QueueTransport([
      response({ content: "recap from the turn's own transport" }), // default fallback summarize call
      response({ content: "final answer" }), // the turn's own call
    ]);
    const events: ConversationRuntimeEvent[] = [];
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "system prompt",
      eventSink: (event) => events.push(event),
      idSource: () => "s",
      clock: () => 1000,
      environment: { LOHRA_CONTEXT_WINDOW: "2000" },
      minKeepMessages: 2,
      summarize,
    });

    const result = await runtime.runTurn({
      input: "next question",
      provider: "ollama",
      model: "m",
      cwd: "/tmp",
      sessionId: "s",
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.response.content).toBe("final answer");
    expect(repository.compactCalls[0]?.summary).toBe("recap from the turn's own transport");
    const fallbackEvent = events.find((event) => event.type === "compaction.aux_fallback");
    expect(fallbackEvent?.code).toBe("Error");
  });

  it("never fires compaction.aux_fallback when the injected summarize succeeds", async () => {
    const repository = new CompactingMemoryRepository();
    repository.createSession({ id: "s", systemPrompt: "sys", model: "m", cwd: "/tmp" });
    repository.messages.set("s", Array.from({ length: 10 }, (_, i) => longTurn(i)).flat());

    const summarize = vi.fn(() => Promise.resolve("aux recap"));
    const transport = new QueueTransport([response({ content: "final answer" })]);
    const events: ConversationRuntimeEvent[] = [];
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "system prompt",
      eventSink: (event) => events.push(event),
      idSource: () => "s",
      clock: () => 1000,
      environment: { LOHRA_CONTEXT_WINDOW: "2000" },
      minKeepMessages: 2,
      summarize,
    });

    await runtime.runTurn({
      input: "next question",
      provider: "ollama",
      model: "m",
      cwd: "/tmp",
      sessionId: "s",
    });

    expect(repository.compactCalls[0]?.summary).toBe("aux recap");
    expect(events.map((event) => event.type)).not.toContain("compaction.aux_fallback");
  });
});
