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

// Issue #608 (menor 5): the ONE fake that distinguishes "ack after commitTurn
// lands" from "ack just before commitTurn is even called" — a transport
// failure (used by the test right below) dies BEFORE commitTurn is ever
// reached at all, so it can't tell the two apart on its own.
class ThrowingCommitRepository extends MemoryRepository {
  override commitTurn(): never {
    throw new Error("commitTurn failed");
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

  it("pins request.system byte-for-byte to the session's systemPrompt with an overlay present (invariant 1, #608 AC3)", async () => {
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
      promptSnapshot: () => "the frozen system prompt",
      idSource: () => "s1",
      clock: () => 1000,
      notices,
    });

    await runtime.runTurn({ input: "hello", provider: "p", model: "m", cwd: "/tmp" });

    // Byte-exact: the overlay lives ONLY in the user message (asserted
    // above); `request.system` and the persisted session's own
    // `systemPrompt` must be the UNCHANGED string `promptSnapshot()`
    // produced, never that string plus the overlay appended.
    expect(transport.requests[0]?.system).toBe("the frozen system prompt");
    expect(repository.session("s1")?.systemPrompt).toBe("the frozen system prompt");
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

  it("never acks when commitTurn ITSELF throws — distinct from a failure before commitTurn is even reached (#608 menor 5)", async () => {
    const repository = new ThrowingCommitRepository();
    const transport = new QueueTransport();
    const notices = new FakeNotices();
    notices.setClaimResult({ token: [3], overlay: "OPERATOR NOTICES (not the user speaking):" });
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
    ).rejects.toThrow("commitTurn failed");

    expect(notices.ackCalls).toEqual([]);
    expect(notices.failureCalls).toHaveLength(1);
    expect(notices.failureCalls[0]?.code).toBe("TURN_FAILED");
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

  it("never persists the overlay into history, so a later turn never resends an acked notice (#608 AC1)", async () => {
    const repository = new MemoryRepository();
    const transport = new QueueTransport();
    const notices = new FakeNotices();
    notices.setClaimResult({
      token: [9],
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

    // Persisted history (what a LATER turn's loadMessages would read back)
    // never carries the overlay block — only the raw user input.
    const persisted = repository.loadMessages("s1");
    const persistedUser = persisted.find((message) => message.role === "user");
    expect(persistedUser?.content).toBe("hello");
    for (const message of persisted) {
      expect(String(message.content)).not.toContain("OPERATOR NOTICES");
    }

    // The notice is already acked (real production behavior) — a second
    // turn's own claim finds nothing pending.
    notices.setClaimResult({ token: [], overlay: null });
    await runtime.runTurn({ input: "again", provider: "p", model: "m", cwd: "/tmp" });

    const secondRequest = transport.requests[1];
    for (const message of secondRequest?.messages ?? []) {
      expect(String(message.content)).not.toContain("OPERATOR NOTICES");
    }
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
