// Issue #586 (épico #575): `ConversationRuntime` reads whatever
// `promptSnapshot()` returns -- a plain string (every caller before this
// issue, and every real caller today: `chat.ts`/`dashboard.ts` still pass
// `.text`) or the full `SystemPromptSnapshot` (`{stable, context, volatile}`)
// -- and forwards it UNFLATTENED to `ModelRequest.system`, so a transport
// that understands bands (`anthropic-messages.ts`) can mark its cache
// breakpoint. The one place that still only ever wants a flat string is the
// PERSISTED row (`ConversationRepository.createSession`, unchanged
// interface) -- this file pins both halves. Molded on
// `tests/conversation-runtime-forced-tool.test.ts`'s fake repository/
// transport shape; never touches that file or the capped
// `tests/conversation-runtime.test.ts`.
import { describe, expect, it } from "vitest";

import { buildSystemPrompt, systemPromptText } from "../src/context/index.js";
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
  readonly created: { readonly systemPrompt: string }[] = [];
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
    this.created.push({ systemPrompt: input.systemPrompt });
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

describe("ConversationRuntime prompt caching plumbing (#586)", () => {
  it("forwards the full SystemPromptSnapshot bands to the transport's ModelRequest.system unflattened", async () => {
    const snapshot = buildSystemPrompt({
      identity: "Soul",
      doctrine: "DOCTRINE",
      systemMessage: "caller",
      today: "2030-01-02",
    });
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport,
      promptSnapshot: () => snapshot,
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "anthropic", model: "m", cwd: "/tmp" });

    expect(transport.requests[0]?.system).toMatchObject({
      stable: snapshot.stable,
      context: snapshot.context,
      volatile: snapshot.volatile,
    });
  });

  it("still persists a flattened string on createSession — the repository's own contract never widens", async () => {
    const snapshot = buildSystemPrompt({
      identity: "Soul",
      doctrine: "DOCTRINE",
      today: "2030-01-02",
    });
    const repository = new MemoryRepository();
    const runtime = new ConversationRuntime({
      repository,
      transport: new QueueTransport(),
      promptSnapshot: () => snapshot,
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "anthropic", model: "m", cwd: "/tmp" });

    expect(repository.created).toHaveLength(1);
    expect(repository.created[0]?.systemPrompt).toBe(systemPromptText(snapshot));
    expect(typeof repository.created[0]?.systemPrompt).toBe("string");
  });

  it("keeps a plain-string promptSnapshot byte-identical — every caller before this issue is unaffected", async () => {
    const transport = new QueueTransport();
    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport,
      promptSnapshot: () => "FLAT SYSTEM TEXT",
      idSource: () => "s1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "anthropic", model: "m", cwd: "/tmp" });

    expect(transport.requests[0]?.system).toBe("FLAT SYSTEM TEXT");
  });
});
