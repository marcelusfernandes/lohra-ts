// Issue #578: `forcedTool` was silently dropped at `OrchestrationChildRuntime.
// spawn`'s own spread (workflow/orchestration-runtime.ts) before ever reaching
// a leaf's request — closing that hop alone is not enough if `ModelRequest`
// itself has no seam for the resulting `tool_choice`. This test proves the
// SECOND half of the fronteira: `ConversationRuntime.runTurn`'s own new
// `toolChoice` input reaches `ModelRequest.toolChoice`, the field every
// transport's `buildKwargs` already reads (`tests/conversation-provider-
// model-tool-choice.test.ts` proves that half). Molded on the existing
// `effort` plumbing test (`tests/conversation-runtime-effort.test.ts`) —
// same fake repository/transport shape, never touching that file or
// `tests/conversation-runtime.test.ts` (#584's own 800-line file).
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

describe("ConversationRuntime forced-tool plumbing (#578)", () => {
  it("forwards runTurn's toolChoice onto ModelRequest.toolChoice — the leaf's own turn now carries the forced-tool name", async () => {
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({
      input: "hi",
      provider: "p",
      model: "m",
      cwd: "/tmp",
      toolChoice: "StructuredOutput",
    });

    // RED on base: ModelRequest had no `toolChoice` field at all and
    // `runTurn`'s own literal never built one — this assertion could not
    // even type-check before the fix.
    expect(transport.requests[0]?.toolChoice).toBe("StructuredOutput");
  });

  it("defaults ModelRequest.toolChoice to null when the caller doesn't pass one — every request before this issue stays neutral", async () => {
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport,
      promptSnapshot: () => "sys",
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "p", model: "m", cwd: "/tmp" });

    expect(transport.requests[0]?.toolChoice).toBeNull();
  });
});
