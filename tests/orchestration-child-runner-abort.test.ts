// Issue #518 (M16-S3, épico #490, ADR 0005): a call already issued that a
// leaf's own stream tears down IN FLIGHT now surfaces through
// `createChildRunner`'s catch as `{status: "interrupted", errorKind:
// "cancelled", partial: true, usageUncertain: true, tokensOut > 0}` instead
// of the bare `{status:"interrupted", tokensOut: 0, errorKind: null}` #232
// placeholder `zeroResult` wrote before this issue. Molded on
// `tests/orchestration-child-runner.test.ts:25-99` (real
// `ChatCompletionsClient`/`ClientPool`/`SessionRepository`, a fake
// `ChatHttpPort` standing in for the real socket) — RED on main (167c2669):
// `ConversationCancelledError` has no `partialUsage` there, and
// `child-runner.ts`'s catch branch never sets `partial`/`errorKind:
// "cancelled"`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClientPool } from "../src/agent/client-pool.js";
import { getProviderProfile } from "../src/providers/index.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import type { ToolDefinition } from "../src/tools/index.js";
import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
  type HttpResponseData,
} from "../src/transports/index.js";
import { createChildRunner } from "../src/orchestration/child-runner.js";
import type { SpawnConfig } from "../src/orchestration/core.js";

const encoder = new TextEncoder();

function sseResponse(frames: readonly unknown[]): HttpResponseData {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: encoder.encode(body),
  };
}

function assistantStream(text: string, promptTokens = 11, completionTokens = 4): HttpResponseData {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } },
  ]);
}

/** A `ChatHttpPort` whose `post()` never settles on its own: it calls
 * `onStarted()` synchronously (so a test can wait for the real HTTP-level
 * request to be in flight, not just for `runner(...)` to have been called —
 * `ConversationRuntime.runTurn`'s own preflight compaction step awaits
 * before the request is ever built, so there is no other reliable point to
 * hang the abort off of) and only rejects once `request.signal` fires, with
 * a real, parseable `StreamAbortedError` carrying `partialBody` — the exact
 * shape `ChatCompletionsClient.stream`'s own abort path
 * (`transports/client.ts`) produces for a genuine in-flight tear-down
 * (mirrors `tests/transports-abort-in-flight.test.ts`'s own `AbortOnlyPort`). */
class AbortOnlyPort implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  constructor(
    private readonly buildError: () => Error,
    private readonly onStarted: () => void,
  ) {}
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.requests.push(request);
    this.onStarted();
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => {
          reject(this.buildError());
        },
        { once: true },
      );
    });
  }
}

const roots: string[] = [];

function setup(): { readonly sessions: SessionRepository; readonly close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lohra-child-runner-abort-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  return {
    sessions: new SessionRepository(connection.database, () => 1000, connection.ftsEnabled),
    close: () => {
      connection.close();
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const parentTools: readonly ToolDefinition[] = [
  { type: "function", function: { name: "read_file", description: "", parameters: {} } },
];

function makeRunner(sessions: SessionRepository, clientPool: ClientPool) {
  return createChildRunner({
    sessions,
    parentSessionId: "parent-1",
    clientPool,
    baseDispatch: () => Promise.resolve("should not be called"),
    parentToolDefinitions: parentTools,
    defaultModel: "fake-model-a",
    cwd: "/tmp",
    idSource: () => "unused",
    clock: () => 1000,
    childMaxIterations: 50,
  });
}

/** Waits for `AbortOnlyPort`'s real HTTP-level request to start, then aborts
 * — never a synchronous abort right after calling `runner(...)`, which would
 * race the pre-issuance check (`signalAborted`, runtime.ts:373/409) instead
 * of exercising the in-flight path this issue is about. */
function startedGate(): { readonly started: Promise<void>; readonly onStarted: () => void } {
  let onStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    onStarted = resolve;
  });
  return { started, onStarted };
}

describe("createChildRunner — abort in flight (issue #518)", () => {
  it("a stream torn down mid-flight resolves interrupted/cancelled with an estimated partial usage, never a bare zero", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const partialBody = encoder.encode(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "x".repeat(29) }, finish_reason: null }],
      })}\n\n`,
    );
    const { started, onStarted } = startedGate();
    const port = new AbortOnlyPort(
      () =>
        new StreamAbortedError(
          { text: "", reasoningChars: 0, toolArgumentChars: 0, usage: null },
          { partialBody },
        ),
      onStarted,
    );
    const client = new ChatCompletionsClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runner = makeRunner(sessions, pool);

    const controller = new AbortController();
    const config: SpawnConfig = { prompt: "do the thing" };
    const pending = runner("child-abort", config, "SYS", () => [], controller.signal);
    await started;
    controller.abort(new Error("USER_CANCELLED"));
    const result = await pending;

    expect(result.status).toBe("interrupted");
    expect(result.errorKind).toBe("cancelled");
    expect(result.usageUncertain).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.tokensOut).toBeGreaterThan(0);
    close();
  });

  // Contra-assertion: a turn that never aborts never carries `partial` at
  // all (absent, never `false`) — this issue's own `zeroResult` spread must
  // not leak the key onto every other outcome.
  it("a turn that completes normally never carries partial at all", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const port = new (class implements ChatHttpPort {
      post(): Promise<HttpResponseData> {
        return Promise.resolve(assistantStream("hi from child"));
      }
    })();
    const client = new ChatCompletionsClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runner = makeRunner(sessions, pool);

    const result = await runner(
      "child-ok",
      { prompt: "do the thing" },
      "SYS",
      () => [],
      new AbortController().signal,
    );

    expect(result.status).toBe("complete");
    expect(Object.hasOwn(result, "partial")).toBe(false);
    close();
  });
});
