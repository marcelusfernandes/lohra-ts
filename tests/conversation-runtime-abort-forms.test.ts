// Issue #568 (M16 pós-revisão, épico #561): extraído de
// tests/conversation-runtime.test.ts (rodada 1b do veredito da PR #573 —
// `contratos` reprovava esse arquivo em 870 linhas, acima do teto de 800)
// — `isAbortOf`'s 3ª forma (`error.cause === signal.reason`) e o usage de
// um turno multi-iteração cancelado pelo signal externo. `MemoryRepository`/
// `response`/`usage` são cópias verbatim dos helpers do arquivo original
// (mesma convenção de pequenos helpers duplicados por arquivo já usada em
// `tests/workflow-orchestration-runtime-timeout.test.ts` vs.
// `tests/orchestration-runtime-collect.test.ts`).
import { describe, expect, it } from "vitest";

import {
  ConversationCancelledError,
  ConversationRuntime,
  type ConversationRepository,
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

const response = (overrides: Partial<NormalizedResponse> = {}): NormalizedResponse => ({
  content: "STUB-OK: deterministic reply",
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage,
  providerData: null,
  ...overrides,
});

describe("ConversationRuntime — isAbortOf's 3rd form and multi-iteration usage on cancel (issue #568)", () => {
  // Issue #568: `isAbortOf`'s 3RD form — a raw `Error` that is neither a
  // `StreamAbortedError` nor named "AbortError", but whose own `.cause` IS
  // the signal's abort reason — had no test of its own (only forms 1/2 were
  // covered above, tests/conversation-runtime.test.ts). No live transport
  // in this tree produces this shape anymore (#567 folded the one that
  // used to into `StreamAbortedError` too, `src/transports/client.ts:150-165`)
  // — kept as defense in depth for an external `ModelTransport`.
  it("classifies a mid-flight abort whose error carries the reason only via .cause (isAbortOf's 3rd form), with no partialUsage", async () => {
    const repository = new MemoryRepository();
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const transport: ModelTransport = {
      complete: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              // Deliberately name "Error" (never "AbortError") and never a
              // StreamAbortedError — the ONLY signal this is an abort is
              // `.cause === signal.reason`.
              reject(new Error("wrapped abort", { cause: signal.reason }));
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
    await started;
    controller.abort("USER_CANCELLED_3RD_FORM");
    await expect(turn).rejects.toBeInstanceOf(ConversationCancelledError);
    const rejected = (await turn.catch((caught: unknown) => caught)) as ConversationCancelledError;
    expect(rejected.partialUsage).toBeNull();
  });

  // Issue #568: a multi-iteration turn (tool-call/pause loop) whose earlier
  // calls already completed for real, then has its LAST call torn down by
  // the OUTER signal, must never drop the earlier real usage back to just
  // the last call's own estimate — `partialUsage` is what `child-runner.ts`
  // reports as the whole leaf's `usage` on cancel (`error.partialUsage`,
  // the ONLY reader of this field), so silently dropping the completed
  // iterations there would under-count a cancelled leaf's real spend.
  it("a multi-iteration turn cancelled by the outer signal sums the EARLIER real usage with the aborted call's estimate, never just the estimate", async () => {
    const repository = new MemoryRepository();
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const { estimatePartialUsage } = await import("../src/context/token-estimate.js");
    const firstUsage = {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const partial = {
      text: "partial-out-text",
      reasoningChars: 0,
      toolArgumentChars: 0,
      usage: null,
    };
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const requests: ModelRequest[] = [];
    let calls = 0;
    const transport: ModelTransport = {
      complete: (request) => {
        requests.push(request);
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            response({ content: "PART1", finishReason: "pause", usage: firstUsage }),
          );
        }
        return new Promise((_, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              reject(new StreamAbortedError(partial, { partialBody: new Uint8Array() }));
            },
            { once: true },
          );
          signalStarted();
        });
      },
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
      provider: "anthropic",
      model: "m",
      cwd: "/tmp",
      signal: controller.signal,
    });
    await started;
    controller.abort("USER_CANCELLED");
    await expect(turn).rejects.toBeInstanceOf(ConversationCancelledError);
    const rejected = (await turn.catch((caught: unknown) => caught)) as ConversationCancelledError;
    const secondRequest = requests[1];
    if (secondRequest === undefined) throw new Error("second request never issued");
    const expectedEstimate = estimatePartialUsage(partial, {
      system: secondRequest.system,
      messages: secondRequest.messages,
      tools: secondRequest.tools,
    });
    expect(rejected.partialUsage).toEqual({
      inputTokens: firstUsage.inputTokens + expectedEstimate.inputTokens,
      outputTokens: firstUsage.outputTokens + expectedEstimate.outputTokens,
      cacheReadTokens: firstUsage.cacheReadTokens,
      cacheWriteTokens: firstUsage.cacheWriteTokens,
      reasoningTokens: firstUsage.reasoningTokens,
    });
  });
});
