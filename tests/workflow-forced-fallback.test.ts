// Issue #403 (M8-7, épico #396): `ChildResult.forcedFallback` (runtime.ts)
// was transported end to end — `orchestration-runtime.ts:223` copies it,
// `engine.ts:332` already checks `collected.forcedFallback === true` to
// bump `forcingFallbacks` — but its only producer, `child-runner.ts`
// (:92,:238 before this fix), hardcoded `false` in every branch, so the
// field could never actually be true and the rollup's `forcing_fallbacks`
// undercounted real model-level fallbacks.
//
// Decision (measured, not assumed): `configureFor` (client-pool.ts:144-149)
// already carries a genuine "the leaf's own resolution fell back" signal —
// `model ??= pair[0].fallbackModels[0] ?? null` (client-pool.ts:146) fires
// exactly when a spawn names a `provider` override with no explicit `model`
// override, so resolution had to pick that provider's own default instead
// of a model the caller actually asked for. That is decidable in
// `child-runner.ts` from `SpawnConfig.provider`/`SpawnConfig.model` alone
// (`providerOverride !== null && modelOverride === null`), so option (a) —
// preencher `forcedFallback: true` in that case — applies; nothing is
// removed. These tests exercise the REAL `createChildRunner`, the only
// file that changed, via `ClientPool` + a fake HTTP transport (same molde
// as `tests/orchestration-child-runner.test.ts`'s "resolves an overridden
// provider/model" case, which already proves `result.model` becomes the
// fallback model but never asserted `forcedFallback` before this issue).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClientPool } from "../src/agent/client-pool.js";
import { createChildRunner } from "../src/orchestration/child-runner.js";
import type { SpawnConfig } from "../src/orchestration/core.js";
import { getProviderProfile, registerProvider } from "../src/providers/index.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import type { ToolDefinition } from "../src/tools/index.js";
import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
  type HttpResponseData,
} from "../src/transports/index.js";

const encoder = new TextEncoder();
const noSignal = new AbortController().signal;

// contract L2: children always stream (see orchestration-child-runner.test.ts).
function sseResponse(frames: readonly unknown[]): HttpResponseData {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: encoder.encode(body),
  };
}

function assistantStream(text: string): HttpResponseData {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ]);
}

class QueuePort implements ChatHttpPort {
  constructor(private readonly queue: Array<HttpResponseData | Error>) {}
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    void request;
    const value = this.queue.shift();
    if (value instanceof Error) return Promise.reject(value);
    if (value === undefined) return Promise.reject(new Error("queue exhausted"));
    return Promise.resolve(value);
  }
}

function fakeClient(queue: Array<HttpResponseData | Error>): ChatCompletionsClient {
  return new ChatCompletionsClient({
    baseUrl: "http://parent.invalid/v1",
    apiKey: "lohra-local",
    transport: new ChatCompletionsTransport(),
    http: new QueuePort(queue),
  });
}

const roots: string[] = [];

function setup(): { readonly sessions: SessionRepository; readonly close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lohra-forced-fallback-"));
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

describe("createChildRunner — forcedFallback (#403)", () => {
  it("is true when a provider override carries no explicit model (client-pool falls back to the provider's own default)", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const parentClient = fakeClient([assistantStream("parent should not answer")]);
    const altProfile = {
      ...parentProfile,
      name: "zforcedfallbackalt",
      aliases: [],
      fallbackModels: ["alt-fallback-model"],
      requiresApiKey: false,
    };
    registerProvider(altProfile);
    const altClient = fakeClient([assistantStream("hi from alt provider")]);
    const pool = new ClientPool(parentProfile, parentClient, {
      home: "/tmp",
      environment: {},
      build: () => altClient,
    });
    const runner = makeRunner(sessions, pool);

    const config: SpawnConfig = { prompt: "do the thing", provider: "zforcedfallbackalt" };
    const result = await runner("child-forced-1", config, "SYS", () => [], noSignal);

    expect(result.status).toBe("complete");
    expect(result.provider).toBe("zforcedfallbackalt");
    expect(result.model).toBe("alt-fallback-model");
    // The bug: before #403's fix, this was hardcoded false in every branch
    // of child-runner.ts's zeroResult, so forcing_fallbacks could never
    // actually rise for a leaf that switched models on its own.
    expect(result.forcedFallback).toBe(true);
    close();
  });

  it("stays false when the provider override also names an explicit model — nothing was chosen FOR the leaf", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const parentClient = fakeClient([assistantStream("parent should not answer")]);
    const altProfile = {
      ...parentProfile,
      name: "zforcedfallbackexplicit",
      aliases: [],
      fallbackModels: ["alt-fallback-model"],
      requiresApiKey: false,
    };
    registerProvider(altProfile);
    const altClient = fakeClient([assistantStream("hi from alt provider, explicit model")]);
    const pool = new ClientPool(parentProfile, parentClient, {
      home: "/tmp",
      environment: {},
      build: () => altClient,
    });
    const runner = makeRunner(sessions, pool);

    const config: SpawnConfig = {
      prompt: "do the thing",
      provider: "zforcedfallbackexplicit",
      model: "requested-model",
    };
    const result = await runner("child-forced-2", config, "SYS", () => [], noSignal);

    expect(result.status).toBe("complete");
    expect(result.model).toBe("requested-model");
    expect(result.forcedFallback).toBe(false);
    close();
  });

  it("stays false with no provider override — the parent's own client/model path is untouched", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const parentClient = fakeClient([assistantStream("hi from the parent's own client")]);
    const pool = new ClientPool(parentProfile, parentClient, { home: "/tmp", environment: {} });
    const runner = makeRunner(sessions, pool);

    const result = await runner("child-forced-3", { prompt: "hi" }, "SYS", () => [], noSignal);

    expect(result.status).toBe("complete");
    expect(result.model).toBe("fake-model-a");
    expect(result.forcedFallback).toBe(false);
    close();
  });

  it("stays false when resolution itself fails (unknown provider) — nothing was actually resolved to fall back to", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const parentClient = fakeClient([assistantStream("unused")]);
    const pool = new ClientPool(parentProfile, parentClient, { home: "/tmp", environment: {} });
    const runner = makeRunner(sessions, pool);

    const config: SpawnConfig = { prompt: "do the thing", provider: "z-unknown-provider" };
    const result = await runner("child-forced-4", config, "SYS", () => [], noSignal);

    expect(result.status).toBe("error");
    expect(result.forcedFallback).toBe(false);
    close();
  });
});
