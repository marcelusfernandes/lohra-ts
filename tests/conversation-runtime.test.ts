import { describe, expect, it, vi } from "vitest";

import {
  ContextWindowExceededError,
  ConversationCancelledError,
  ConversationRuntime,
  ConversationTurnFailedError,
  IncompleteToolCallError,
  MaxIterationsError,
  UnexpectedToolCallError,
  type CompactionResult,
  type ConversationRepository,
  type ConversationRuntimeEvent,
  type ModelRequest,
  type ModelTransport,
  type TurnCommit,
} from "../src/conversation/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";

const usage = {
  inputTokens: 11,
  outputTokens: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

class MemoryRepository implements ConversationRepository {
  readonly sessions = new Map<string, { systemPrompt: string; model: string; cwd: string }>();
  readonly messages = new Map<string, Readonly<Record<string, unknown>>[]>();
  readonly commits: TurnCommit[] = [];
  readonly usageCommits: unknown[] = [];

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
    return structuredClone(this.messages.get(id) ?? []);
  }

  commitTurn(commit: TurnCommit): void {
    this.commits.push(structuredClone(commit));
    const current = this.messages.get(commit.sessionId) ?? [];
    this.messages.set(commit.sessionId, [
      ...current,
      ...(commit.messages ?? [commit.user, commit.assistant]),
    ]);
  }

  commitUsage(commit: unknown): void {
    this.usageCommits.push(structuredClone(commit));
  }

  summary(id: string) {
    const commits = this.commits.filter((entry) => entry.sessionId === id);
    return {
      inputTokens: commits.reduce((total, entry) => total + (entry.usage?.inputTokens ?? 0), 0),
      outputTokens: commits.reduce((total, entry) => total + (entry.usage?.outputTokens ?? 0), 0),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiCallCount: commits.length,
      pricedCallCount: commits.filter((entry) => entry.cost !== null).length,
      actualCostUsd: commits.reduce((total, entry) => total + (entry.cost?.usd ?? 0), 0),
      estimatedCostUsd: commits.reduce((total, entry) => total + (entry.cost?.grossUsd ?? 0), 0),
    };
  }
}

// Issue #252: an in-memory stand-in for the three optional compaction
// members of ConversationRepository, backed by a single-holder lock map
// (good enough for single-process tests -- cross-process locking is
// covered against the real SessionRepository in tests/state-locks.test.ts).
class CompactingMemoryRepository extends MemoryRepository {
  private readonly locks = new Map<
    string,
    { readonly holder: string; readonly expiresAt: number }
  >();
  readonly compactCalls: {
    readonly sessionId: string;
    readonly keepTailCount: number;
    readonly summary: string;
  }[] = [];

  acquireCompressionLock(
    sessionId: string,
    holder: string,
    now: number,
    ttlSeconds: number,
  ): boolean {
    const existing = this.locks.get(sessionId);
    if (existing !== undefined && existing.expiresAt > now && existing.holder !== holder) {
      return false;
    }
    this.locks.set(sessionId, { holder, expiresAt: now + ttlSeconds });
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
  ): CompactionResult {
    this.compactCalls.push({
      sessionId,
      keepTailCount: input.keepTailCount,
      summary: input.summary,
    });
    const current = this.messages.get(sessionId) ?? [];
    const keepCount = Math.min(Math.max(0, input.keepTailCount), current.length);
    const summarizedCount = current.length - keepCount;
    if (summarizedCount <= 0) return { summarizedCount: 0, keptCount: current.length };
    const kept = current.slice(summarizedCount);
    // Mirrors the real SessionRepository.compactHistory shape (issue #252
    // fixup): a synthetic user lead before the assistant summary, never a
    // bare assistant message first (Anthropic rejects that as the first
    // message of a request).
    const leadMessage = { role: "user", content: "(resumo da conversa anterior a seguir)" };
    const summaryMessage = { role: "assistant", content: input.summary, finish_reason: "stop" };
    this.messages.set(sessionId, [leadMessage, summaryMessage, ...kept]);
    return { summarizedCount, keptCount: kept.length };
  }
}

class QueueTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  closes = 0;

  constructor(private readonly responses: readonly NormalizedResponse[]) {}

  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) throw new Error("TEST_RESPONSE_MISSING");
    return Promise.resolve(response);
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }
}

const response = (overrides: Partial<NormalizedResponse> = {}): NormalizedResponse => ({
  content: "STUB-OK: deterministic reply",
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage,
  providerData: null,
  ...overrides,
});

describe("ConversationRuntime", () => {
  it("freezes the prompt once, resumes history, and commits complete turns", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport([response(), response()]);
    const events: ConversationRuntimeEvent[] = [];
    let prompts = 0;
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => {
        prompts += 1;
        return "frozen prompt";
      },
      eventSink: (event) => events.push(event),
      idSource: () => "session-1",
      clock: () => 1000,
    });

    const first = await runtime.runTurn({
      input: "one",
      provider: "ollama",
      model: "m",
      cwd: "/tmp/project",
    });
    const second = await runtime.runTurn({
      input: "two",
      provider: "ollama",
      model: "m",
      cwd: "/tmp/project",
      sessionId: first.sessionId,
    });

    expect(prompts).toBe(1);
    expect(transport.requests[1]?.messages).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "STUB-OK: deterministic reply", finish_reason: "stop" },
      { role: "user", content: "two" },
    ]);
    expect(repository.commits).toHaveLength(2);
    expect(second.sessionSummary).toMatchObject({
      inputTokens: 22,
      outputTokens: 14,
      apiCallCount: 2,
      pricedCallCount: 2,
    });
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "model.request.started",
      "model.request.completed",
      "turn.completed",
      "turn.started",
      "model.request.started",
      "model.request.completed",
      "turn.completed",
    ]);
    expect(transport.closes).toBe(2);
  });

  it("fails closed on unexpected tool calls without dispatch or persistence", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport([
      response({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "read_file", arguments: "{}", providerData: null }],
      }),
    ]);
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "p",
      idSource: () => "s",
      clock: () => 1,
    });
    await expect(
      runtime.runTurn({ input: "x", provider: "ollama", model: "m", cwd: "/tmp" }),
    ).rejects.toMatchObject({
      name: "UnexpectedToolCallError",
      code: "UNEXPECTED_TOOL_CALL",
    } satisfies Partial<UnexpectedToolCallError>);
    expect(repository.commits).toEqual([]);
  });

  it("bounds continuations when a dispatcher is supplied", async () => {
    const repository = new MemoryRepository();
    const tool = { id: "c1", name: "read_file", arguments: "{}", providerData: null };
    const transport = new QueueTransport([
      response({ content: null, finishReason: "tool_calls", toolCalls: [tool] }),
      response({ content: null, finishReason: "tool_calls", toolCalls: [tool] }),
    ]);
    const dispatch = vi.fn(() => Promise.resolve({ role: "tool", content: "ok" }));
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "p",
      toolDispatcher: { dispatch },
      idSource: () => "s",
      clock: () => 1,
      maxIterations: 1,
    });
    await expect(
      runtime.runTurn({ input: "x", provider: "ollama", model: "m", cwd: "/tmp" }),
    ).rejects.toBeInstanceOf(MaxIterationsError);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(repository.commits).toEqual([]);
    expect(repository.usageCommits).toHaveLength(1);
  });

  it("dispatches parallel calls in input order and persists the four-message tool turn", async () => {
    const repository = new MemoryRepository();
    const calls = [
      { id: "c1", name: "read_file", arguments: '{"path":"a"}', providerData: null },
      { id: "c2", name: "read_file", arguments: '{"path":"b"}', providerData: null },
    ];
    const transport = new QueueTransport([
      response({ content: null, finishReason: "tool_calls", toolCalls: calls }),
      response(),
    ]);
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "p",
      toolDefinitions: [{ type: "function", function: { name: "read_file" } }],
      toolDispatcher: {
        dispatch: async (call) => {
          if (call.id === "c1") await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            role: "tool",
            name: call.name,
            tool_call_id: call.id,
            content: `result:${call.id ?? "null"}`,
          };
        },
      },
      idSource: () => "s",
      clock: () => 1,
    });
    const result = await runtime.runTurn({
      input: "x",
      provider: "ollama",
      model: "m",
      cwd: "/tmp",
    });
    expect(transport.requests[0]?.tools).toHaveLength(1);
    expect(transport.requests[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ]);
    expect(repository.messages.get("s")?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(result.usageTotal).toMatchObject({ inputTokens: 22, outputTokens: 14 });
    expect(result.toolCalls?.map((call) => call.result)).toEqual(["result:c1", "result:c2"]);
  });

  it("replays pause responses without dispatch and persists provider data", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport([
      response({
        content: "PART1",
        finishReason: "pause",
        reasoning: "r1",
        providerData: { thinking_blocks: [{ signature: "s", thinking: "r1", type: "thinking" }] },
        usage: { ...usage, inputTokens: 10, outputTokens: 4 },
      }),
      response({
        content: "PART2",
        finishReason: "pause",
        providerData: { thinking_blocks: [{ signature: "s2", thinking: "r2", type: "thinking" }] },
        usage: { ...usage, inputTokens: 0, outputTokens: 0 },
      }),
      response({ content: "DONE", usage: { ...usage, inputTokens: 6, outputTokens: 3 } }),
    ]);
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "p",
      idSource: () => "s",
      clock: () => 1,
    });
    const result = await runtime.runTurn({
      input: "x",
      provider: "anthropic",
      model: "m",
      cwd: "/tmp",
    });
    expect(
      transport.requests.map((request) =>
        request.messages.map((message) => [message.role, message.content]),
      ),
    ).toEqual([
      [["user", "x"]],
      [
        ["user", "x"],
        ["assistant", "PART1"],
      ],
      [
        ["user", "x"],
        ["assistant", "PART1"],
        ["assistant", "PART2"],
      ],
    ]);
    expect(result.apiCalls).toBe(3);
    expect(result.usageTotal).toMatchObject({ inputTokens: 16, outputTokens: 7 });
    const storedPause = repository.messages.get("s")?.[1];
    expect(storedPause).toMatchObject({
      role: "assistant",
      content: "PART1",
      reasoning: "r1",
    });
    expect(
      Array.isArray((storedPause?.provider_data as { thinking_blocks?: unknown }).thinking_blocks),
    ).toBe(true);
  });

  // The loop classifies a failure ENTIRELY by the error the call itself
  // raised — it never asks "was the signal aborted?" here, matching the
  // oracle's own loop.py (interrupt is checked only before issuing the next
  // call; the except block around the provider call classifies purely by
  // the caught exception). This matters specifically for a transport that
  // consumes the signal for real mid-flight cancellation (the non-streaming
  // path): the resulting error is a genuine abort, but it is still just
  // ANOTHER turn failure here — never reclassified into
  // ConversationCancelledError after the fact. Cancellation is exclusively
  // a pre-iteration, call-never-issued signal (see the next test); a call
  // that was already issued and then failed — for any reason, including a
  // real abort a consuming transport honored — is a turn failure. Getting
  // this wrong previously meant every child failure during orchestration
  // teardown (which unconditionally aborts every child before awaiting any
  // of them) silently lost its real cause and reported as "interrupted".
  it("classifies a mid-flight failure from an abort-consuming transport as a turn failure, not a cancellation, and always closes transport", async () => {
    const repository = new MemoryRepository();
    let observed = false;
    let closes = 0;
    // Issue #252's preflight compaction check adds an `await` before the
    // call is issued, so aborting synchronously right after runTurn() is
    // invoked (the old shape of this test) now races in during that gap
    // and is legitimately classified as pre-issuance cancellation instead
    // -- this deferred signals the abort only once the call has actually
    // been issued and the listener attached, which is what this test means
    // to pin regardless of how many microtask ticks preflight takes.
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const transport: ModelTransport = {
      complete: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observed = true;
              const abortError = new Error("The operation was aborted");
              abortError.name = "AbortError";
              reject(abortError);
            },
            { once: true },
          );
          signalStarted();
        }),
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    };
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "p",
      idSource: () => "s",
      clock: () => 1,
    });
    const controller = new AbortController();
    const turn = runtime.runTurn({
      input: "x",
      provider: "ollama",
      model: "m",
      cwd: "/tmp",
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(turn).rejects.toBeInstanceOf(ConversationTurnFailedError);
    await expect(turn).rejects.toThrow(/aborted/);
    expect(observed).toBe(true);
    expect(repository.commits).toEqual([]);
    expect(closes).toBe(1);
  });

  it("throws ConversationCancelledError before issuing the next call when the signal is already aborted — the call is never made", async () => {
    const repository = new MemoryRepository();
    let calls = 0;
    const transport = new QueueTransport([
      response({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "noop", arguments: "{}", providerData: null }],
      }),
    ]);
    const wrapped: ModelTransport = {
      complete: (request) => {
        calls += 1;
        return transport.complete(request);
      },
      close: () => transport.close(),
    };
    const controller = new AbortController();
    const runtime = new ConversationRuntime({
      repository,
      transport: wrapped,
      promptSnapshot: () => "p",
      idSource: () => "s",
      clock: () => 1,
      toolDispatcher: {
        dispatch: () => {
          controller.abort();
          return Promise.resolve({ role: "tool", content: "ok" });
        },
      },
    });
    const turn = runtime.runTurn({
      input: "x",
      provider: "ollama",
      model: "m",
      cwd: "/tmp",
      signal: controller.signal,
    });
    await expect(turn).rejects.toBeInstanceOf(ConversationCancelledError);
    // The tool call's own iteration's request went out (calls === 1); the
    // SECOND iteration's request — checked for abort before being built —
    // must never be issued.
    expect(calls).toBe(1);
  });

  it("records normalized usage but no messages for an incomplete tool call", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport([
      response({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "", arguments: "", providerData: null }],
      }),
    ]);
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "p",
      idSource: () => "s",
      clock: () => 1,
    });
    await expect(
      runtime.runTurn({ input: "x", provider: "ollama", model: "m", cwd: "/tmp" }),
    ).rejects.toMatchObject({
      name: "IncompleteToolCallError",
      code: "INCOMPLETE_TOOL_CALL",
      usage,
    } satisfies Partial<IncompleteToolCallError>);
    expect(repository.commits).toEqual([]);
    expect(repository.usageCommits).toHaveLength(1);
  });
});

describe("ConversationRuntime — compaction preflight (issue #252)", () => {
  function longTurn(id: number): Readonly<Record<string, unknown>>[] {
    return [
      { role: "user", content: `q${String(id)} ${"x".repeat(2000)}` },
      { role: "assistant", content: `a${String(id)} ${"y".repeat(2000)}`, finish_reason: "stop" },
    ];
  }

  it("compacts the overflowing history before the call, and the call goes through", async () => {
    const repository = new CompactingMemoryRepository();
    repository.createSession({ id: "s", systemPrompt: "sys", model: "m", cwd: "/tmp" });
    const seeded = Array.from({ length: 10 }, (_, i) => longTurn(i)).flat();
    repository.messages.set("s", seeded);

    const summaryText = "recap of earlier turns";
    const transport = new QueueTransport([
      response({ content: summaryText }), // the internal summarize call
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
    });

    const result = await runtime.runTurn({
      input: "next question",
      provider: "ollama",
      model: "m",
      cwd: "/tmp",
      sessionId: "s",
    });

    expect(result.response.content).toBe("final answer");
    expect(result.compaction).toMatchObject({ summarizedCount: 18, keptCount: 2 });
    expect(repository.compactCalls).toHaveLength(1);
    expect(repository.compactCalls[0]?.summary).toBe(summaryText);
    // The request that actually reached the transport is far shorter than
    // the seeded history -- proof the compaction ran before the call, not
    // just that the repository's bookkeeping says it did.
    const finalRequest = transport.requests.at(-1);
    expect(finalRequest?.messages.length).toBeLessThan(seeded.length);
    expect(events.map((event) => event.type)).toContain("session.compacted");
    const compactedEvent = events.find((event) => event.type === "session.compacted");
    expect(compactedEvent?.compaction).toMatchObject({ summarizedCount: 18, keptCount: 2 });
  });

  it("never compacts twice in the same turn — a second overflow is refused with a named fault", async () => {
    const repository = new CompactingMemoryRepository();
    repository.createSession({ id: "s", systemPrompt: "sys", model: "m", cwd: "/tmp" });
    repository.messages.set("s", Array.from({ length: 10 }, (_, i) => longTurn(i)).flat());

    const transport = new QueueTransport([
      response({ content: "recap" }), // summarize call
      response({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "noop", arguments: "{}", providerData: null }],
      }), // the turn's first call, after compaction #1
    ]);
    const dispatch = vi.fn(() =>
      // A giant tool result blows the (still tiny, forced) window right
      // back open on the very next iteration.
      Promise.resolve({ role: "tool", tool_call_id: "c1", content: "z".repeat(50_000) }),
    );
    const runtime = new ConversationRuntime({
      repository,
      transport,
      toolDispatcher: { dispatch },
      promptSnapshot: () => "system prompt",
      idSource: () => "s",
      clock: () => 1000,
      environment: { LOHRA_CONTEXT_WINDOW: "2000" },
      minKeepMessages: 2,
    });

    await expect(
      runtime.runTurn({
        input: "next question",
        provider: "ollama",
        model: "m",
        cwd: "/tmp",
        sessionId: "s",
      }),
    ).rejects.toBeInstanceOf(ContextWindowExceededError);
    // Exactly one compaction happened -- the second overflow was refused,
    // never attempted again.
    expect(repository.compactCalls).toHaveLength(1);
  });
});
