import { describe, expect, it } from "vitest";

import {
  ConversationRuntime,
  MaxIterationsError,
  MessageInjectionError,
  type ConversationRepository,
  type ConversationRuntimeEvent,
  type ModelRequest,
  type ModelTransport,
  type TurnCommit,
} from "../src/conversation/index.js";
import { emptyPartialStream, StreamAbortedError } from "../src/transports/index.js";
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

// Issue #520 (M16-S5, épico #490, ADR 0005): a call already in flight, torn
// down by a steer-driven `interruptSource` rather than the outer `signal`
// itself, is absorbed with `continue` — the turn keeps going, never
// `turn.failed`. RED on main 167c2669: `interruptSource` doesn't exist on
// `runTurn`'s input, so a caller has no seam to arm at all, and the loop's
// only abort classification is the outer `signal` (`ConversationTurnFailedError`
// for anything else).
describe("ConversationRuntime interruptSource — steer-driven interrupt (issue #520)", () => {
  it("tears the in-flight call down, discards its partial, drains the inbox on the next iteration, counts the estimated usage, and completes the turn", async () => {
    const repository = new MemoryRepository();
    // A boxed holder, not a bare `let` — reading a bare `let (() => void) |
    // null = null` back via `?.()` after only ever assigning it INSIDE a
    // nested closure narrows TS's flow type all the way to literal `null`
    // (`NonNullable<null>` is `never`, and TS refuses to call that), the
    // same reason `src/conversation/runtime.ts`'s own `signalAborted` reads
    // `.aborted` through a function call instead of a bare property access.
    const hook: { armed: (() => void) | null } = { armed: null };
    let disarmed = false;
    const interruptSource = {
      arm: (abort: () => void): (() => void) => {
        hook.armed = abort;
        return () => {
          disarmed = true;
        };
      },
    };
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const requests: ModelRequest[] = [];
    let calls = 0;
    const transport: ModelTransport = {
      complete: (request) => {
        requests.push(structuredClone(request));
        calls += 1;
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                reject(
                  new StreamAbortedError({
                    text: "partial reply text before the interrupt landed",
                    reasoningChars: 0,
                    toolArgumentChars: 0,
                    usage: null,
                  }),
                );
              },
              { once: true },
            );
            signalStarted();
          });
        }
        return Promise.resolve(finalResponse());
      },
      close: () => Promise.resolve(),
    };
    const events: ConversationRuntimeEvent[] = [];
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "SYSTEM",
      idSource: () => "session-interrupt",
      clock: () => 0,
      eventSink: (event) => events.push(event),
    });

    let drainCalls = 0;
    const drained: readonly Readonly<Record<string, unknown>>[][] = [
      [],
      [{ role: "user", content: "<system-reminder>\nSTEER-TEXT\n</system-reminder>" }],
    ];

    const turn = runtime.runTurn({
      input: "hi",
      provider: "fakeprov",
      model: "fake-model",
      cwd: "/tmp",
      interruptSource,
      drainMessages: () => {
        const batch = drained[drainCalls] ?? [];
        drainCalls += 1;
        return batch;
      },
    });

    await started;
    expect(hook.armed).not.toBeNull();
    hook.armed?.();

    const result = await turn;

    expect(calls).toBe(2);
    expect(result.response.content).toBe("done");
    expect(result.partialCalls).toBe(1);
    expect(result.usageTotal?.outputTokens ?? 0).toBeGreaterThan(0);
    expect(disarmed).toBe(true);
    expect(events.some((event) => event.type === "model.request.interrupted")).toBe(true);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    // The steer text queued for "the next iteration" reached the second
    // (successful) request's own messages.
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "<system-reminder>\nSTEER-TEXT\n</system-reminder>" },
    ]);
    // The interrupted call's own partial text never reaches the persisted
    // turn — discarded entirely, never pushed to messages/turnMessages.
    const persisted = JSON.stringify(repository.commits[0]?.messages ?? []);
    expect(persisted).not.toContain("partial reply text before the interrupt landed");
  });

  it("contra-assertion: an external cancel during the same call takes precedence over an armed interrupt — never `continue`", async () => {
    const repository = new MemoryRepository();
    const interruptSource = {
      arm:
        (_abort: () => void): (() => void) =>
        () =>
          undefined,
    };
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let calls = 0;
    const transport: ModelTransport = {
      complete: (request) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          request.signal.addEventListener(
            "abort",
            () => {
              const abortError = new Error("The operation was aborted");
              abortError.name = "AbortError";
              reject(abortError);
            },
            { once: true },
          );
          signalStarted();
        }),
      close: () => Promise.resolve(),
    };
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "SYSTEM",
      idSource: () => "session-cancel-precedence",
      clock: () => 0,
    });
    const controller = new AbortController();

    const turn = runtime.runTurn({
      input: "hi",
      provider: "fakeprov",
      model: "fake-model",
      cwd: "/tmp",
      signal: controller.signal,
      interruptSource,
    });

    await started;
    controller.abort("USER_CANCELLED");

    await expect(turn).rejects.toThrow(/conversation cancelled/i);
    expect(calls).toBe(1); // never a second (retried/`continue`d) call
  });

  it("contra-assertion: an interrupted call still counts toward maxIterations — never a free retry", async () => {
    const repository = new MemoryRepository();
    let armed: (() => void) | null = null;
    const interruptSource = {
      arm: (abort: () => void): (() => void) => {
        armed = abort;
        return () => {
          armed = null;
        };
      },
    };
    let calls = 0;
    const transport: ModelTransport = {
      complete: (request) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          request.signal.addEventListener(
            "abort",
            () => {
              reject(new StreamAbortedError(emptyPartialStream));
            },
            { once: true },
          );
          queueMicrotask(() => armed?.());
        }),
      close: () => Promise.resolve(),
    };
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "SYSTEM",
      idSource: () => "session-max-iterations",
      clock: () => 0,
      maxIterations: 2,
    });

    await expect(
      runtime.runTurn({
        input: "hi",
        provider: "fakeprov",
        model: "fake-model",
        cwd: "/tmp",
        interruptSource,
      }),
    ).rejects.toBeInstanceOf(MaxIterationsError);
    expect(calls).toBe(2);
  });
});
