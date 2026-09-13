// Issue #589 (épico #575 P13): proves the wiring `ConversationRuntime.
// runTurn` gained for the operator-notices overlay — claim at the top of
// the turn, overlay attached to the user message (never the system
// prompt), ack only after `commitTurn`, `publishFailure` on `turn.failed`,
// and byte-identical behavior when `options.notices` is absent (AC5).
// Fake repository/transport shape lifted from
// `tests/conversation-runtime-forced-tool.test.ts` — never touching that
// file or `tests/conversation-runtime.test.ts` (#584's own 800-line file).
import { describe, expect, it } from "vitest";

import { ConversationRuntime } from "../src/conversation/index.js";
import type {
  ConversationRepository,
  ModelRequest,
  ModelTransport,
  TurnCommit,
  TurnNoticesClaim,
  TurnNoticesPort,
} from "../src/conversation/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

class MemoryRepository implements ConversationRepository {
  private readonly sessions = new Map<
    string,
    { systemPrompt: string; model: string; cwd: string }
  >();
  private readonly messages = new Map<string, Readonly<Record<string, unknown>>[]>();
  public lastCommit: TurnCommit | undefined;

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
    this.lastCommit = commit;
    this.messages.set(commit.sessionId, [...(commit.messages ?? [])]);
  }
  commitUsage(): void {
    // unused in this test
  }
  summary() {
    return null;
  }
}

class QueueTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  private readonly responses: (() => Promise<NormalizedResponse>)[];
  constructor(responses?: (() => Promise<NormalizedResponse>)[]) {
    this.responses = responses ?? [];
  }
  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(structuredClone(request));
    const next = this.responses.shift();
    if (next !== undefined) return next();
    return Promise.resolve({
      content: "ok",
      finishReason: "stop",
      toolCalls: [],
      reasoning: null,
      usage,
      providerData: null,
    });
  }
  close(): void {
    // no-op
  }
}

class FakeNotices implements TurnNoticesPort {
  claimCalls: string[] = [];
  ackCalls: (readonly number[])[] = [];
  failureCalls: { sessionId: string; code: string; cause: unknown }[] = [];
  private claimResult: TurnNoticesClaim = { token: [], overlay: null };

  setClaimResult(result: TurnNoticesClaim): void {
    this.claimResult = result;
  }
  claim(sessionId: string): TurnNoticesClaim {
    this.claimCalls.push(sessionId);
    return this.claimResult;
  }
  ack(token: readonly number[]): void {
    this.ackCalls.push(token);
  }
  publishFailure(sessionId: string, code: string, cause: unknown): void {
    this.failureCalls.push({ sessionId, code, cause });
  }
}

describe("ConversationRuntime notices overlay (#589)", () => {
  it("attaches the overlay to the user message content, never to session.systemPrompt (AC1)", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport();
    const notices = new FakeNotices();
    notices.setClaimResult({
      token: [7],
      overlay: "OPERATOR NOTICES (not the user speaking):\n- [unknown] a pending notice",
    });
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
      notices,
    });

    await runtime.runTurn({ input: "hello", provider: "p", model: "m", cwd: "/tmp" });

    expect(notices.claimCalls).toEqual(["s1"]);
    const sentMessages = transport.requests[0]?.messages ?? [];
    const userMessage = sentMessages.find((message) => message.role === "user");
    expect(userMessage?.content).toContain("a pending notice");
    expect(userMessage?.content).toContain("hello");
    expect(repository.session("s1")?.systemPrompt).toBe("sys");
  });

  it("acks the claimed token only after commitTurn lands (AC3)", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport();
    const notices = new FakeNotices();
    notices.setClaimResult({ token: [1, 2], overlay: "OPERATOR NOTICES (not the user speaking):" });
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
      notices,
    });

    await runtime.runTurn({ input: "hello", provider: "p", model: "m", cwd: "/tmp" });

    expect(repository.lastCommit).toBeDefined();
    expect(notices.ackCalls).toEqual([[1, 2]]);
  });

  it("never acks when the turn fails before commitTurn — the notice stays claimable next turn (AC3)", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport([() => Promise.reject(new Error("provider down"))]);
    const notices = new FakeNotices();
    notices.setClaimResult({ token: [1], overlay: "OPERATOR NOTICES (not the user speaking):" });
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
      notices,
    });

    await expect(
      runtime.runTurn({ input: "hello", provider: "p", model: "m", cwd: "/tmp" }),
    ).rejects.toThrow();

    expect(notices.ackCalls).toEqual([]);
  });

  it("publishes a turn-failure notice with the failing code when the turn dies (AC4)", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport([() => Promise.reject(new Error("provider down"))]);
    const notices = new FakeNotices();
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
      notices,
    });

    await expect(
      runtime.runTurn({ input: "hello", provider: "p", model: "m", cwd: "/tmp" }),
    ).rejects.toThrow();

    expect(notices.failureCalls).toHaveLength(1);
    expect(notices.failureCalls[0]?.sessionId).toBe("s1");
    expect(notices.failureCalls[0]?.code).toBe("MODEL_CALL_FAILED");
  });

  it("is byte-identical to a turn without the notices option when there is nothing pending (AC5)", async () => {
    const repository = new MemoryRepository();
    const transportWithNotices = new QueueTransport();
    const notices = new FakeNotices();
    const runtimeWithNotices = new ConversationRuntime({
      repository,
      transport: transportWithNotices,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
      notices,
    });
    await runtimeWithNotices.runTurn({ input: "hello", provider: "p", model: "m", cwd: "/tmp" });

    const baselineRepository = new MemoryRepository();
    const transportBaseline = new QueueTransport();
    const runtimeBaseline = new ConversationRuntime({
      repository: baselineRepository,
      transport: transportBaseline,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
    });
    await runtimeBaseline.runTurn({ input: "hello", provider: "p", model: "m", cwd: "/tmp" });

    expect(transportWithNotices.requests).toEqual(transportBaseline.requests);
  });

  it("never claims/acks/publishes when options.notices is absent — pre-#589 behavior unchanged", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository,
      transport,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
    });

    const result = await runtime.runTurn({
      input: "hello",
      provider: "p",
      model: "m",
      cwd: "/tmp",
    });

    expect(result.response.content).toBe("ok");
    const userMessage = transport.requests[0]?.messages.find((message) => message.role === "user");
    expect(userMessage?.content).toBe("hello");
  });
});
