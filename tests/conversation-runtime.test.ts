import { describe, expect, it, vi } from "vitest";

import {
  ConversationCancelledError,
  ConversationRuntime,
  ConversationTurnFailedError,
  IncompleteToolCallError,
  MaxIterationsError,
  UnexpectedToolCallError,
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
