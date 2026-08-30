import { describe, expect, it } from "vitest";

import {
  ConversationRuntime,
  type ConversationRepository,
  type ModelRequest,
  type ModelTransport,
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
  readonly sessions = new Map<string, { systemPrompt: string; model: string; cwd: string }>();

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

  loadMessages(): readonly Readonly<Record<string, unknown>>[] {
    return [];
  }

  commitTurn(): void {}
  commitUsage(): void {}

  summary() {
    return null;
  }
}

/** Records only serializable request facts (a real `onText` callback can't
 * survive structuredClone) and, when present, invokes it to simulate a
 * provider streaming deltas mid-call. */
class DeltaRecordingTransport implements ModelTransport {
  readonly sawOnText: boolean[] = [];
  closes = 0;

  constructor(
    private readonly result: NormalizedResponse,
    private readonly deltasToEmit: readonly string[] = [],
  ) {}

  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.sawOnText.push(typeof request.onText === "function");
    for (const delta of this.deltasToEmit) request.onText?.(delta);
    return Promise.resolve(this.result);
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }
}

const response = (overrides: Partial<NormalizedResponse> = {}): NormalizedResponse => ({
  content: "final",
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage,
  providerData: null,
  ...overrides,
});

describe("ConversationRuntime streaming deltas", () => {
  it("forwards runTurn's onDelta into every ModelRequest as onText", async () => {
    const transport = new DeltaRecordingTransport(response(), ["he", "llo"]);
    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport,
      promptSnapshot: () => "system",
      idSource: () => "session-1",
      clock: () => 1000,
    });

    const seen: string[] = [];
    const result = await runtime.runTurn({
      input: "hi",
      provider: "ollama",
      model: "m",
      cwd: "/tmp/project",
      onDelta: (text) => seen.push(text),
    });

    expect(seen).toEqual(["he", "llo"]);
    expect(transport.sawOnText).toEqual([true]);
    expect(result.response.content).toBe("final");
  });

  it("does not attach onText to the request when runTurn is called without onDelta", async () => {
    const transport = new DeltaRecordingTransport(response());
    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport,
      promptSnapshot: () => "system",
      idSource: () => "session-1",
      clock: () => 1000,
    });

    await runtime.runTurn({ input: "hi", provider: "ollama", model: "m", cwd: "/tmp/project" });

    expect(transport.sawOnText).toEqual([false]);
  });

  it("forwards onDelta across every iteration of a multi-call turn", async () => {
    // Force two iterations via a tool call round-trip, then a final response.
    const toolResponse = response({
      content: null,
      finishReason: "tool_calls",
      toolCalls: [{ id: "c1", name: "noop", arguments: "{}", providerData: null }],
    });
    const transport = new DeltaRecordingTransport(response());
    let calls = 0;
    const originalComplete = transport.complete.bind(transport);
    transport.complete = (request: ModelRequest) => {
      calls += 1;
      return calls === 1
        ? (transport.sawOnText.push(typeof request.onText === "function"), Promise.resolve(toolResponse))
        : originalComplete(request);
    };

    const runtime = new ConversationRuntime({
      repository: new MemoryRepository(),
      transport,
      promptSnapshot: () => "system",
      toolDispatcher: { dispatch: () => Promise.resolve({ role: "tool", content: "" }) },
      idSource: () => "session-1",
      clock: () => 1000,
    });

    await runtime.runTurn({
      input: "hi",
      provider: "ollama",
      model: "m",
      cwd: "/tmp/project",
      onDelta: () => {},
    });

    expect(transport.sawOnText).toEqual([true, true]);
  });
});
