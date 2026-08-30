import { describe, expect, it } from "vitest";

import {
  ConversationCancelledError,
  ConversationRuntime,
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
    this.messages.set(commit.sessionId, [...current, commit.user, commit.assistant]);
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
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "p",
      toolDispatcher: { dispatch: () => Promise.resolve({ role: "tool", content: "ok" }) },
      idSource: () => "s",
      clock: () => 1,
      maxIterations: 1,
    });
    await expect(
      runtime.runTurn({ input: "x", provider: "ollama", model: "m", cwd: "/tmp" }),
    ).rejects.toBeInstanceOf(MaxIterationsError);
    expect(repository.commits).toEqual([]);
  });

  it("observes cancellation and always closes transport", async () => {
    const repository = new MemoryRepository();
    let observed = false;
    const transport: ModelTransport = {
      complete: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observed = true;
              reject(signal.reason instanceof Error ? signal.reason : new Error("ABORTED"));
            },
            { once: true },
          );
        }),
      close: () => Promise.resolve(),
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
    await expect(turn).rejects.toBeInstanceOf(ConversationCancelledError);
    expect(observed).toBe(true);
    expect(repository.commits).toEqual([]);
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
