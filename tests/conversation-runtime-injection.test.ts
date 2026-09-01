import { describe, expect, it } from "vitest";

import {
  ConversationRuntime,
  MessageInjectionError,
  type ConversationRepository,
  type ModelRequest,
  type ModelTransport,
  type TurnCommit,
} from "../src/conversation/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";

// This file is dedicated to the drainMessages injection hook alone — no
// orchestration code lives here. It is a shared file: conversation/runtime.ts
// is touched by three lanes right now (T11's onDelta streaming seam, T12's
// provisional copy of the same, and this one). This slice's diff is the
// smallest addition that satisfies steer's mid-turn injection requirement
// (contract T13 decision 6/L6) without adding any orchestration-specific
// vocabulary to the shared runtime.

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

  commitUsage(): void {
    // not exercised by this file
  }

  summary() {
    return null;
  }
}

class QueueTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: readonly NormalizedResponse[]) {}

  complete(request: ModelRequest): Promise<NormalizedResponse> {
    // Mirrors the existing conversation-runtime.test.ts fake: structuredClone
    // is exactly the operation that breaks if a function value ever reaches
    // ModelRequest. This hook never does — it only ever mutates the plain
    // message list before the request is built.
    this.requests.push(structuredClone(request));
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) throw new Error("TEST_RESPONSE_MISSING");
    return Promise.resolve(response);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const toolCallResponse = (): NormalizedResponse => ({
  content: null,
  finishReason: "tool_calls",
  toolCalls: [{ id: "call_1", name: "noop", arguments: "{}", providerData: null }],
  reasoning: null,
  usage,
  providerData: null,
});

const finalResponse = (): NormalizedResponse => ({
  content: "done",
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage,
  providerData: null,
});

function makeRuntime(transport: QueueTransport, repository: ConversationRepository) {
  return new ConversationRuntime({
    repository,
    transport,
    promptSnapshot: () => "SYSTEM",
    toolDispatcher: { dispatch: () => Promise.resolve({ role: "tool", content: "{}" }) },
    idSource: () => "session-1",
    clock: () => 0,
  });
}

describe("ConversationRuntime drainMessages injection", () => {
  it("is neutral when omitted: request shape and persisted turn are unchanged", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport([finalResponse()]);
    const runtime = makeRuntime(transport, repository);

    const result = await runtime.runTurn({
      input: "hi",
      provider: "fakeprov",
      model: "fake-model",
      cwd: "/tmp",
    });

    expect(result.response.content).toBe("done");
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(repository.commits[0]?.messages).toEqual([
      { role: "user", content: "hi" },
      expect.objectContaining({ role: "assistant", content: "done" }),
    ]);
  });

  it("drains at the top of every iteration, including the first, before the request is built", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport([toolCallResponse(), finalResponse()]);
    let calls = 0;
    const drained: readonly Readonly<Record<string, unknown>>[][] = [
      [{ role: "user", content: "<system-reminder>\nSTEER-ONE\n</system-reminder>" }],
      [],
    ];
    const runtime = makeRuntime(transport, repository);

    await runtime.runTurn({
      input: "hi",
      provider: "fakeprov",
      model: "fake-model",
      cwd: "/tmp",
      drainMessages: () => {
        const batch = drained[calls] ?? [];
        calls += 1;
        return batch;
      },
    });

    expect(calls).toBe(2); // called once per iteration, both iterations
    // Iteration 1's request already carries the injected message, proving
    // the drain happens before the request is built, on the first iteration.
    // Injected messages append AFTER the existing ones (contract L6: "logo
    // depois do prompt base" for the queued-on-first-iteration case).
    expect(transport.requests[0]?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "<system-reminder>\nSTEER-ONE\n</system-reminder>" },
    ]);
    // The injected message is persisted as part of the completed turn.
    expect(repository.commits[0]?.messages?.[1]).toEqual({
      role: "user",
      content: "<system-reminder>\nSTEER-ONE\n</system-reminder>",
    });
  });

  it("propagates a wrapped error with the cause preserved when drainMessages throws — never silent, never swallowed", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport([finalResponse()]);
    const runtime = makeRuntime(transport, repository);
    const cause = new Error("inbox lock poisoned");

    try {
      await runtime.runTurn({
        input: "hi",
        provider: "fakeprov",
        model: "fake-model",
        cwd: "/tmp",
        drainMessages: () => {
          throw cause;
        },
      });
      expect.fail("expected runTurn to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(MessageInjectionError);
      expect((error as Error).cause).toBe(cause);
    }
    // No request ever reached the transport for the failed attempt — the
    // failure happens before the request is built, not swallowed downstream.
    expect(transport.requests).toHaveLength(0);
  });

  it("type system: drainMessages must be omitted when unset, not set to undefined", () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport([finalResponse()]);
    const runtime = makeRuntime(transport, repository);
    // @ts-expect-error exactOptionalPropertyTypes forbids `drainMessages: undefined` —
    // callers must omit the key entirely, matching the T11 onDelta precedent.
    void runtime.runTurn({
      input: "hi",
      provider: "fakeprov",
      model: "fake-model",
      cwd: "/tmp",
      drainMessages: undefined,
    });
  });
});
