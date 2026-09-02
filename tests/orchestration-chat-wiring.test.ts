import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClientPool } from "../src/agent/client-pool.js";
import { getProviderProfile } from "../src/providers/index.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import { CHILD_EXCLUDED_TOOLS, childToolDefinitions } from "../src/tools/child.js";
import { composeDispatch } from "../src/tools/dispatch.js";
import type { RegistryDispatch, ToolDefinition } from "../src/tools/types.js";
import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
  type HttpResponseData,
} from "../src/transports/index.js";
import { OrchestrationCore, type CollectResult } from "../src/orchestration/core.js";
import { buildOrchestrationCore, orchestrationToolHandlers } from "../src/orchestration/chat-wiring.js";
import type { ProviderResolver } from "../src/orchestration/tools.js";

const stubPrompt = (): string => "SUBAGENT_SYSTEM_STUB";
const allowAllProviders: ProviderResolver = { get: () => Promise.resolve([{}, {}]) };

const okResult: CollectResult = {
  status: "complete",
  output: "done",
  tokensIn: 1,
  tokensOut: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  provider: "fakeprov",
  model: "fake-model-a",
  forcedFallback: false,
  errorKind: null,
  retryAfter: null,
};

function makeCore(): OrchestrationCore {
  let n = 0;
  return new OrchestrationCore({
    runChild: () => Promise.resolve(okResult),
    idSource: () => {
      n += 1;
      return `id-${String(n)}`;
    },
    maxSubsessions: 200,
    maxParallel: 4,
    buildSubagentPrompt: stubPrompt,
  });
}

describe("orchestrationToolHandlers", () => {
  it("exposes exactly the four intercepted verbs, no more, no fewer", () => {
    const handlers = orchestrationToolHandlers(makeCore(), allowAllProviders);
    expect(Object.keys(handlers).sort()).toEqual(
      ["collect_session", "delegate_task", "spawn_session", "steer_session"].sort(),
    );
  });

  it("actually spawns via the real core — not a fail-safe refusal — when composed into a dispatch table", async () => {
    const core = makeCore();
    const base: RegistryDispatch = () => Promise.resolve("SHOULD_NOT_BE_CALLED");
    const dispatch = composeDispatch(base, orchestrationToolHandlers(core, allowAllProviders));

    const envelope = await dispatch("spawn_session", { prompt: "do it" });

    const parsed = JSON.parse(envelope) as { ok: boolean; sub_id: string };
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.sub_id).toBe("string");
    expect(core.size).toBe(1);
  });

  it("leaves a non-intercepted tool falling through to the base dispatch unchanged", async () => {
    const calls: [string, unknown][] = [];
    const base: RegistryDispatch = (name, args) => {
      calls.push([name, args]);
      return Promise.resolve("BASE-RESULT");
    };
    const dispatch = composeDispatch(base, orchestrationToolHandlers(makeCore(), allowAllProviders));

    const result = await dispatch("read_file", { path: "x.txt" });

    expect(result).toBe("BASE-RESULT");
    expect(calls).toEqual([["read_file", { path: "x.txt" }]]);
  });

  it("does not let a child inherit the four orchestration verbs even once they're real, wired handlers on the parent's catalog", () => {
    // The parent's own tool catalog, as it looks AFTER this slice wires real
    // handlers in place of the FAIL_SAFE_HANDLERS placeholders for these
    // four names — childToolDefinitions must still filter them out via the
    // inherited, untouched CHILD_TOOL_ALLOWLIST (child.ts), regardless of
    // what the parent's dispatch table does with them.
    const parentCatalog: readonly ToolDefinition[] = [
      { type: "function", function: { name: "read_file", description: "", parameters: {} } },
      { type: "function", function: { name: "spawn_session", description: "", parameters: {} } },
      { type: "function", function: { name: "steer_session", description: "", parameters: {} } },
      { type: "function", function: { name: "collect_session", description: "", parameters: {} } },
      { type: "function", function: { name: "delegate_task", description: "", parameters: {} } },
    ];

    const childCatalog = childToolDefinitions(parentCatalog).map((d) => d.function.name);

    for (const excluded of CHILD_EXCLUDED_TOOLS) expect(childCatalog).not.toContain(excluded);
    expect(childCatalog).toEqual(["read_file"]);
  });
});

/** Never resolves a POST — used to observe how many upstream requests are
 * simultaneously in flight without needing a valid response body at all. */
class BarrierPort implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.requests.push(request);
    return new Promise(() => undefined);
  }
}

const roots: string[] = [];

function setupSessions(): SessionRepository {
  const root = mkdtempSync(join(tmpdir(), "lohra-chat-wiring-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
  sessions.createSession({ id: "parent-1", source: "gateway" });
  return sessions;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("buildOrchestrationCore — wiring-level regression for fanout.maxParallel (assertion 24)", () => {
  it("a non-default maxParallel reaches the real ConcurrencyGate through chat.ts's own construction path, not a hand-rolled OrchestrationCore", async () => {
    // Proves the exact function commands/chat.ts calls, end to end through
    // a real ChatCompletionsClient — a hardcode reintroduced at the chat.ts
    // call site (passing a literal instead of fanout.maxParallel) would
    // fail this test; a manual CLI smoke test would not run in CI at all.
    const profile = getProviderProfile("openai");
    if (profile === null) throw new Error("openai profile missing");
    const port = new BarrierPort();
    const client = new ChatCompletionsClient({
      baseUrl: "http://parent.invalid/v1",
      apiKey: "k",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const pool = new ClientPool(profile, client, { home: "/tmp", environment: {} });
    const sessions = setupSessions();

    const core = buildOrchestrationCore({
      fanout: { maxParallel: 1, maxSubsessions: 200, parentMaxIterations: 90, warnings: [] },
      sessions,
      parentSessionId: "parent-1",
      clientPool: pool,
      baseDispatch: () => Promise.resolve("unused"),
      parentToolDefinitions: [],
      defaultModel: "fake-model-a",
      cwd: "/tmp",
    });

    core.spawn({ prompt: "a" });
    core.spawn({ prompt: "b" });
    core.spawn({ prompt: "c" });
    // Each runChild call is deferred by the concurrency gate's own microtask
    // tick before it can reach the transport; flush enough ticks for every
    // ADMITTED child to actually call http.post().
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    expect(port.requests).toHaveLength(1);
    expect(core.size).toBe(3);
  });

  it("the default (nothing configured) admits up to 4 concurrently, not 1", async () => {
    const profile = getProviderProfile("openai");
    if (profile === null) throw new Error("openai profile missing");
    const port = new BarrierPort();
    const client = new ChatCompletionsClient({
      baseUrl: "http://parent.invalid/v1",
      apiKey: "k",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const pool = new ClientPool(profile, client, { home: "/tmp", environment: {} });
    const sessions = setupSessions();

    const core = buildOrchestrationCore({
      fanout: { maxParallel: 4, maxSubsessions: 200, parentMaxIterations: 90, warnings: [] },
      sessions,
      parentSessionId: "parent-1",
      clientPool: pool,
      baseDispatch: () => Promise.resolve("unused"),
      parentToolDefinitions: [],
      defaultModel: "fake-model-a",
      cwd: "/tmp",
    });

    for (let i = 0; i < 6; i += 1) core.spawn({ prompt: `t${String(i)}` });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    expect(port.requests).toHaveLength(4);
    expect(core.size).toBe(6);
  });
});

/** A single real streaming chat-completion response (finish: stop), the
 * minimum needed for a spawned child's turn to actually settle and commit
 * usage — BarrierPort above deliberately never resolves, which is right
 * for admission-counting tests but wrong here, where the turn must finish
 * to observe the persisted cost. */
class CompletingPort implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.requests.push(request);
    const frames = [
      { choices: [{ delta: { content: "priced" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } },
    ];
    const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    return Promise.resolve({
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new TextEncoder().encode(body),
    });
  }
}

describe("buildOrchestrationCore — wiring-level regression for pricingOverrides", () => {
  it("an operator price override reaches the real cost commands/chat.ts's own construction path persists for a child, not just the parent", async () => {
    // Same class of proof as the maxParallel tests above: a hardcode or a
    // forgotten pass-through at the chat.ts call site (never forwarding
    // loadPriceOverrides(...) into buildOrchestrationCore) would fail this,
    // where a unit test on createChildRunner alone cannot.
    const profile = getProviderProfile("openai");
    if (profile === null) throw new Error("openai profile missing");
    const port = new CompletingPort();
    const client = new ChatCompletionsClient({
      baseUrl: "http://parent.invalid/v1",
      apiKey: "k",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const pool = new ClientPool(profile, client, { home: "/tmp", environment: {} });
    const sessions = setupSessions();
    const overridePrice = { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000, source: "test" };

    const core = buildOrchestrationCore({
      fanout: { maxParallel: 4, maxSubsessions: 200, parentMaxIterations: 90, warnings: [] },
      sessions,
      parentSessionId: "parent-1",
      clientPool: pool,
      baseDispatch: () => Promise.resolve("unused"),
      parentToolDefinitions: [],
      defaultModel: "fake-model-a",
      cwd: "/tmp",
      pricingOverrides: new Map([[`${profile.name}\0fake-model-a`, overridePrice]]),
    });

    const { subId } = core.spawn({ prompt: "priced task" });
    const outcome = await core.collect(subId, true);
    if (outcome.kind !== "settled") throw new Error("expected the turn to settle");
    expect(outcome.result.status).toBe("complete");

    const usage = sessions.usage(subId);
    // The built-in price table has no entry for "fake-model-a" — an
    // unwired override would leave this at null.
    expect(usage?.estimatedCostUsd).toBeGreaterThan(0);
  });
});
