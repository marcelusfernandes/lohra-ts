// Issue #429 (M10-S8, épico #421 "Supervisão em voo") — decisão 3 do mapa
// do épico (aditivo, precedente #232): `delegate_task` passa a devolver, por
// tarefa, `error_kind`/`tokens_in`/`tokens_out`/`provider`/`model` (5 chaves
// novas NO FIM de cada item de `results`, as 3 originais intactas na
// ordem), e um turno final sem texto e sem tool calls ganha nome —
// `dead_turn`, nunca `unknown` (reservado a `ProviderCallFailed`).
//
// Molde: `tests/orchestration-tools.test.ts` (envelope de `delegate_task`)
// e `tests/orchestration-child-runner.test.ts` (fake HTTP real via
// `createChildRunner`) — nenhum dos dois é editado além do pino que a
// issue já autoriza em `orchestration-tools.test.ts`.
//
// Vermelho na base: `results[i]` só tem 3 chaves (`error_kind` etc.
// ausentes) e um turno vazio nunca carrega `errorKind` — as asserções
// abaixo reprovam por valor ausente/`undefined`, nunca por erro de
// coleta (`DelegateOutcome`/`ERROR_KINDS` já existem na base, só sem os
// campos/valor novos).
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
import {
  OrchestrationCore,
  type CollectResult,
  type SpawnConfig,
} from "../src/orchestration/core.js";
import { delegateTaskTool } from "../src/orchestration/tools.js";
import { publicAuditEvent } from "../src/workflow/audit-model.js";

const stubPrompt = (): string => "SUBAGENT_SYSTEM_STUB";

const okResult = (overrides: Partial<CollectResult> = {}): CollectResult => ({
  status: "complete",
  output: "done",
  tokensIn: 11,
  tokensOut: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  provider: "fakeprov",
  model: "fake-model-a",
  forcedFallback: false,
  errorKind: null,
  retryAfter: null,
  ...overrides,
});

function makeCore(
  runChild: ConstructorParameters<typeof OrchestrationCore>[0]["runChild"],
): OrchestrationCore {
  let n = 0;
  return new OrchestrationCore({
    runChild,
    idSource: () => {
      n += 1;
      return `kid-${String(n)}`;
    },
    maxSubsessions: 200,
    maxParallel: 200,
    buildSubagentPrompt: stubPrompt,
  });
}

describe("delegate_task envelope (#429): 8 keys per task", () => {
  it("returns error_kind/tokens_in/tokens_out/provider/model, appended after the 3 original keys, in task order", async () => {
    const core = makeCore((_subId, config: SpawnConfig) =>
      Promise.resolve(
        okResult({
          output: `${config.prompt}-OUT`,
          tokensIn: 21,
          tokensOut: 13,
          provider: "openai",
          model: "gpt-fake",
        }),
      ),
    );

    const envelope = await delegateTaskTool(core, { tasks: ["one", "two"] });
    const parsed = JSON.parse(envelope) as {
      ok: boolean;
      results: readonly Readonly<Record<string, unknown>>[];
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.results).toHaveLength(2);
    for (const [index, item] of parsed.results.entries()) {
      // The 3 original keys, first and unchanged.
      expect(Object.keys(item).slice(0, 3)).toEqual(["sub_id", "status", "summary"]);
      expect(item.sub_id).toBe(`kid-${String(index + 1)}`);
      expect(item.status).toBe("complete");
      // The 5 new keys, appended at the end (precedente #232).
      expect(Object.keys(item).slice(3)).toEqual([
        "error_kind",
        "tokens_in",
        "tokens_out",
        "provider",
        "model",
      ]);
      expect(item.error_kind).toBeNull();
      expect(item.tokens_in).toBe(21);
      expect(item.tokens_out).toBe(13);
      expect(item.provider).toBe("openai");
      expect(item.model).toBe("gpt-fake");
    }
  });

  it("carries a non-null error_kind through when the child's own turn errored", async () => {
    const core = makeCore(() =>
      Promise.resolve(
        okResult({
          status: "error",
          output: "boom",
          errorKind: "route_fault",
        }),
      ),
    );

    const envelope = await delegateTaskTool(core, { tasks: ["one"] });
    const parsed = JSON.parse(envelope) as {
      results: readonly Readonly<Record<string, unknown>>[];
    };
    expect(parsed.results[0]?.status).toBe("error");
    expect(parsed.results[0]?.error_kind).toBe("route_fault");
  });
});

// Real HTTP fake through `createChildRunner`, molde
// `tests/orchestration-child-runner.test.ts` — proves `dead_turn` end to
// end, not just the shape `zeroResult` builds.
const encoder = new TextEncoder();
const noSignal = new AbortController().signal;

function sseResponse(frames: readonly unknown[]): HttpResponseData {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: encoder.encode(body),
  };
}

function assistantStream(text: string, promptTokens = 5, completionTokens = 1): HttpResponseData {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } },
  ]);
}

// Molde `tests/orchestration-child-runner.test.ts:64` — a tool-call frame,
// used below to prove the `dead_turn` guard checks BOTH halves of its
// condition (empty content AND no tool calls), not just the content half.
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

class QueuePort implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  constructor(private readonly queue: Array<HttpResponseData | Error>) {}
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.requests.push(request);
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
  const root = mkdtempSync(join(tmpdir(), "lohra-delegate-envelope-"));
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

describe("createChildRunner: dead_turn (#429)", () => {
  it("names a final turn with no text and no tool calls dead_turn, keeping status complete and output empty", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const client = fakeClient([assistantStream("")]);
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runner = createChildRunner({
      sessions,
      parentSessionId: "parent-1",
      clientPool: pool,
      baseDispatch: () => Promise.resolve("should not be called"),
      parentToolDefinitions: parentTools,
      defaultModel: "fake-model-a",
      cwd: "/tmp",
      idSource: () => "unused",
      clock: () => 1000,
      childMaxIterations: 50,
    });

    const result = await runner("child-dead", { prompt: "do nothing" }, "SYS", () => [], noSignal);

    expect(result.status).toBe("complete");
    expect(result.output).toBe("");
    expect(result.errorKind).toBe("dead_turn");
    expect(result.errorKind).not.toBe("unknown");
    expect(result.usageUncertain).toBe(false);
    close();
  });

  it("leaves a turn with real final text with errorKind null, never dead_turn", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const client = fakeClient([assistantStream("hello")]);
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runner = createChildRunner({
      sessions,
      parentSessionId: "parent-1",
      clientPool: pool,
      baseDispatch: () => Promise.resolve("should not be called"),
      parentToolDefinitions: parentTools,
      defaultModel: "fake-model-a",
      cwd: "/tmp",
      idSource: () => "unused",
      clock: () => 1000,
      childMaxIterations: 50,
    });

    const result = await runner("child-alive", { prompt: "say hi" }, "SYS", () => [], noSignal);

    expect(result.status).toBe("complete");
    expect(result.output).toBe("hello");
    expect(result.errorKind).toBeNull();
    close();
  });

  // Guard in child-runner.ts is `content.trim() === "" && toolCalls.length
  // === 0` — BOTH halves have to hold. This proves the tool-calls half: an
  // empty final content after a tool call ran earlier in the SAME turn is
  // real work that produced no closing text, not a dead turn.
  it("keeps errorKind null when the final content is empty but the turn already executed a tool call", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const client = fakeClient([
      toolCallStream("read_file", '{"path":"x"}', "call_1"),
      assistantStream(""),
    ]);
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runner = createChildRunner({
      sessions,
      parentSessionId: "parent-1",
      clientPool: pool,
      baseDispatch: () => Promise.resolve(JSON.stringify({ ok: true, result: "x" })),
      parentToolDefinitions: parentTools,
      defaultModel: "fake-model-a",
      cwd: "/tmp",
      idSource: () => "unused",
      clock: () => 1000,
      childMaxIterations: 50,
    });

    const result = await runner(
      "child-tool-then-empty",
      { prompt: "read x" },
      "SYS",
      () => [],
      noSignal,
    );

    expect(result.status).toBe("complete");
    expect(result.output).toBe("");
    expect(result.errorKind).toBeNull();
    close();
  });

  // Proves the content half of the guard uses `.trim()`, not a bare `===
  // ""` — whitespace-only content with no tool calls is still dead.
  it("names dead_turn when the final content is whitespace-only and no tool calls ran", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const client = fakeClient([assistantStream("   \n")]);
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runner = createChildRunner({
      sessions,
      parentSessionId: "parent-1",
      clientPool: pool,
      baseDispatch: () => Promise.resolve("should not be called"),
      parentToolDefinitions: parentTools,
      defaultModel: "fake-model-a",
      cwd: "/tmp",
      idSource: () => "unused",
      clock: () => 1000,
      childMaxIterations: 50,
    });

    const result = await runner(
      "child-whitespace",
      { prompt: "do nothing" },
      "SYS",
      () => [],
      noSignal,
    );

    expect(result.status).toBe("complete");
    expect(result.output).toBe("   \n");
    expect(result.errorKind).toBe("dead_turn");
    close();
  });
});

// This proves only the ALLOW-LIST MECHANISM (ERROR_KIND_SET, `audit-model
// .ts:184`), not a real production path: `dead_turn` always arrives with
// `status: "complete"`, and `audit-runtime.ts`'s `leaf.completed` branch
// (:242-251) never carries `error_kind` at all — only `leaf.failed`
// (:253-259, `status: "failed" | "cancelled"`) does, a status `dead_turn`
// never has. This just confirms the vocabulary check itself would not
// single out `dead_turn` for exclusion if it ever reached this payload
// shape — the real place `dead_turn` surfaces is `RunResult.faultKinds`
// (`accounting.ts`'s `recordFaultKind`, via `debitLeaf`), not a `leaf.*`
// audit event.
describe("dead_turn accepted by the audit allow-list mechanism (#429)", () => {
  it("the ERROR_KIND_SET allow-list would preserve a dead_turn error_kind, same as any other vocabulary value — not a claim that production ever emits leaf.failed with dead_turn", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "leaf.failed", payload: { status: "failed", error_kind: "dead_turn" } },
      1,
    );
    expect(event.data.error_kind).toBe("dead_turn");
  });
});
