// Issue #568 (M16 pós-revisão, épico #561): extraído de
// tests/conversation-runtime.test.ts (rodada 1b do veredito da PR #573 —
// `contratos` reprovava esse arquivo em 870 linhas, acima do teto de 800)
// — `isAbortOf`'s 3ª forma (`error.cause === signal.reason`) e o usage de
// um turno multi-iteração cancelado pelo signal externo. `MemoryRepository`/
// `response`/`usage` são cópias verbatim dos helpers do arquivo original
// (mesma convenção de pequenos helpers duplicados por arquivo já usada em
// `tests/workflow-orchestration-runtime-timeout.test.ts` vs.
// `tests/orchestration-runtime-collect.test.ts`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClientPool } from "../src/agent/client-pool.js";
import {
  ConversationCancelledError,
  ConversationRuntime,
  type ConversationRepository,
  type ModelRequest,
  type ModelTransport,
  type TurnCommit,
} from "../src/conversation/index.js";
import { createChildRunner } from "../src/orchestration/child-runner.js";
import type { SpawnConfig } from "../src/orchestration/core.js";
import { getProviderProfile } from "../src/providers/index.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import type { ToolDefinition } from "../src/tools/index.js";
import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
  type HttpResponseData,
  type NormalizedResponse,
} from "../src/transports/index.js";

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

  // Issue #568 (r2, veredito da PR #573): a multi-iteration turn (tool-call/
  // pause loop) whose earlier calls already completed for real, then has
  // its LAST call torn down by the OUTER signal via `StreamAbortedError`,
  // must never drop the earlier real usage entirely — it rides along as
  // `measuredUsage`, a field SEPARATE from `partialUsage` (this call's own
  // estimate). Merging the two into `partialUsage` itself (r1's fix) broke
  // the contract that field documents and made `child-runner.ts` mislabel
  // a leaf `partial` even when nothing was ever estimated for a DIFFERENT
  // isAbortOf form — see the child-runner-level tests below for that.
  it("a multi-iteration turn cancelled by StreamAbortedError keeps the EARLIER real usage as measuredUsage, separate from the aborted call's own estimate", async () => {
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
    // Issue #568 (r2, veredito da PR #573): the two are SEPARATE fields —
    // `partialUsage` stays ONLY this call's own estimate (the contract
    // `errors.ts` documents), `measuredUsage` carries the earlier real
    // iteration's usage. `child-runner.ts` is the one that combines them;
    // this test pins the split at the source.
    expect(rejected.partialUsage).toEqual(expectedEstimate);
    expect(rejected.measuredUsage).toEqual(firstUsage);
  });
});

// Issue #568 (r2, veredito da PR #573): `child-runner.ts`'s catch branch
// combines `measuredUsage`/`partialUsage` into the leaf's own `usage`, but
// derives `partial` from `partialUsage` ALONE — this is the level where
// that distinction is actually observable end to end, through a REAL
// `createChildRunner` (`OrchestrationCore`+`ClientPool`, a fake
// `ChatHttpPort` standing in for the socket, never a hand-rolled
// `ConversationRuntime` double), molded on
// `tests/orchestration-child-runner-abort.test.ts`.
const encoder = new TextEncoder();

function sseResponse(frames: readonly unknown[]): HttpResponseData {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: encoder.encode(body),
  };
}

function toolCallStream(name: string, args: string, callId: string): HttpResponseData {
  return sseResponse([
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: callId, function: { name, arguments: args } }] },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ]);
}

/** First call resolves with `toolCallStream` (a real tool-call iteration,
 * real usage); every call AFTER that hangs until `request.signal` fires,
 * then rejects with whatever `buildAbortError` constructs — the caller
 * decides the exact shape (a raw `AbortError`, isAbortOf's 2nd form, or a
 * real `StreamAbortedError`, its 1st) so ONE port serves both scenarios
 * below. */
class ToolThenAbortPort implements ChatHttpPort {
  private calls = 0;
  constructor(
    private readonly buildAbortError: () => Error,
    private readonly onSecondStarted: () => void,
  ) {}
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.calls += 1;
    if (this.calls === 1) {
      return Promise.resolve(toolCallStream("read_file", '{"path":"a"}', "c1"));
    }
    this.onSecondStarted();
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => {
          reject(this.buildAbortError());
        },
        { once: true },
      );
    });
  }
}

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const parentTools: readonly ToolDefinition[] = [
  { type: "function", function: { name: "read_file", description: "", parameters: {} } },
];

function harness(buildAbortError: () => Error, onSecondStarted: () => void) {
  const root = mkdtempSync(join(tmpdir(), "lohra-child-runner-cancel-usage-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
  sessions.createSession({ id: "parent-1", source: "gateway" });
  const parentProfile = getProviderProfile("openai");
  if (parentProfile === null) throw new Error("openai profile missing");
  const port = new ToolThenAbortPort(buildAbortError, onSecondStarted);
  const client = new ChatCompletionsClient({
    baseUrl: "http://127.0.0.1:9",
    apiKey: "k",
    transport: new ChatCompletionsTransport(),
    http: port,
  });
  const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
  const runner = createChildRunner({
    sessions,
    parentSessionId: "parent-1",
    clientPool: pool,
    baseDispatch: () => Promise.resolve('{"ok":true}'),
    parentToolDefinitions: parentTools,
    defaultModel: "fake-model-a",
    cwd: "/tmp",
    idSource: () => "unused",
    clock: () => 1000,
    childMaxIterations: 50,
  });
  return {
    start: (): {
      readonly pending: ReturnType<typeof runner>;
      readonly abort: (reason: unknown) => void;
    } => {
      const controller = new AbortController();
      const config: SpawnConfig = { prompt: "do the thing" };
      const pending = runner("child-cancel-usage", config, "SYS", () => [], controller.signal);
      return {
        pending,
        abort: (reason: unknown) => {
          controller.abort(reason);
        },
      };
    },
    close: (): void => {
      connection.close();
    },
  };
}

function startedGate(): { readonly started: Promise<void>; readonly onStarted: () => void } {
  let onStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    onStarted = resolve;
  });
  return { started, onStarted };
}

describe("createChildRunner — cancel usage combines measuredUsage/partialUsage, partial follows partialUsage alone (issue #568 r2)", () => {
  it("cancel via isAbortOf's 2nd form (raw AbortError) after a completed tool-call iteration: usage is the real measured usage, partial is false", async () => {
    const { started, onStarted } = startedGate();
    const { start, close } = harness(() => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      return abortError;
    }, onStarted);
    try {
      const { pending, abort } = start();
      await started;
      abort(new Error("USER_CANCELLED"));
      const result = await pending;
      expect(result.status).toBe("interrupted");
      expect(result.errorKind).toBe("cancelled");
      expect(result.usageUncertain).toBe(true);
      // Nothing was ever ESTIMATED (no StreamAbortedError to estimate
      // from) — only the earlier tool-call iteration's REAL usage — so
      // this leaf is `partial: false` (this catch branch always sets the
      // key, never omits it), matching `RunResult.partialLeaves`'s
      // contract (a leaf counts as partial only when its usage includes an
      // estimated portion).
      expect(result.partial).toBe(false);
      expect(result.tokensIn).toBe(5);
      expect(result.tokensOut).toBe(2);
    } finally {
      close();
    }
  });

  it("cancel via isAbortOf's 1st form (StreamAbortedError) after a completed tool-call iteration: usage is real + estimated, partial is true", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const { started, onStarted } = startedGate();
    const partialBody = encoder.encode(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "x".repeat(29) }, finish_reason: null }],
      })}\n\n`,
    );
    const { start, close } = harness(
      () =>
        new StreamAbortedError(
          { text: "", reasoningChars: 0, toolArgumentChars: 0, usage: null },
          { partialBody },
        ),
      onStarted,
    );
    try {
      const { pending, abort } = start();
      await started;
      abort(new Error("USER_CANCELLED"));
      const result = await pending;
      expect(result.status).toBe("interrupted");
      expect(result.errorKind).toBe("cancelled");
      expect(result.usageUncertain).toBe(true);
      // The aborted call DID estimate something (a real StreamAbortedError,
      // non-empty partial text) — combined with the earlier tool-call
      // iteration's real usage, both riding on the same `usage`.
      expect(result.partial).toBe(true);
      expect(result.tokensIn).toBeGreaterThan(5);
      expect(result.tokensOut).toBeGreaterThan(2);
    } finally {
      close();
    }
  });
});
