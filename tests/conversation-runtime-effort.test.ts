import { describe, expect, it } from "vitest";

import { ConversationRuntime } from "../src/conversation/index.js";
import type {
  ConversationRepository,
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

class MemoryRepository implements ConversationRepository {
  private readonly sessions = new Map<
    string,
    { systemPrompt: string; model: string; cwd: string }
  >();
  private readonly messages = new Map<string, Readonly<Record<string, unknown>>[]>();

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
}

class QueueTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(structuredClone(request));
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

describe("ConversationRuntime effort plumbing", () => {
  it("forwards runTurn's effort onto ModelRequest.effort", async () => {
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "p", model: "m", cwd: "/tmp", effort: "high" });

    expect(transport.requests[0]?.effort).toBe("high");
  });

  it("defaults ModelRequest.effort to null when the caller doesn't pass one — neutral in absence", async () => {
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "p", model: "m", cwd: "/tmp" });

    expect(transport.requests[0]?.effort).toBeNull();
  });
});
