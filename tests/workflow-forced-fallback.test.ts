// Issue #403 (M8-7, épico #396), rodada 2 — o revisor reprovou a decisão
// (a) da rodada 1: `providerOverride !== null && modelOverride === null` é
// o caso NORMAL "nomeei provider e deixei o modelo por conta dele"
// (`provider` é um ROUTING_FIELDS comum, `src/workflow/nodes.ts:7`), e
// `pair[0].fallbackModels[0]` (client-pool.ts:149) é o DEFAULT do
// provedor — usado por `chat.ts`, `wizard.ts` e `dashboard.ts` no caminho
// feliz, não um sinal de fallback. Nada no código percorre
// `fallbackModels[1..]`, e um modelo inexistente vira `model_not_found`
// (transports/error-kinds.ts) sem retry — não existe um sinal real de "a
// folha trocou de modelo porque o pedido falhou". Decisão corrigida: (b)
// REMOVER `ChildResult.forcedFallback` (`runtime.ts`) e os três lugares que
// só repassavam o valor sempre-false que os produtores nunca preenchiam de
// verdade (`engine.ts:332`, `orchestration-runtime.ts:223`,
// `audit-runtime.ts:251`) mais `"forced_fallback"` de `BOOLEAN_FIELDS`
// (`audit-model.ts`, nenhum produtor restante). `forcing_fallbacks`
// continua alimentado SÓ por `usedFallback` — o engine's próprio fallback
// de schema forçado (`engine-utils.ts:249-250`: pediu `StructuredOutput` e
// a folha não fez a chamada, então o texto cru é usado).
//
// Na época desta rodada, `src/orchestration/core.ts`
// (`CollectResult.forcedFallback: boolean`) e `src/orchestration/tools.ts`
// (o envelope `collect_session`, 13 chaves pinadas, ADR 0003) NÃO mudavam —
// o campo morto era só o repasse em `orchestration-runtime.ts`. Issue #419
// (owner OK, 2026-09-13) revisita essa mesma decisão e remove o campo/chave
// que aqui ficaram: `CollectResult` não tem mais `forcedFallback`, e o
// envelope de `collect_session` cai para 12 chaves.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClientPool } from "../src/agent/client-pool.js";
import { createChildRunner } from "../src/orchestration/child-runner.js";
import {
  OrchestrationCore,
  type ChildRunner,
  type CollectResult,
  type SpawnConfig,
} from "../src/orchestration/core.js";
import { getProviderProfile } from "../src/providers/index.js";
import {
  openStateDatabase,
  SessionRepository,
  WorkflowRepository,
  LockRepository,
  AuditRepository,
} from "../src/state/index.js";
import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
  type HttpResponseData,
} from "../src/transports/index.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import type {
  CausalContext,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import { WorkflowEngine, validateSpec } from "../src/workflow/index.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function ok(output: string): CollectResult {
  return {
    status: "complete",
    output,
    tokensIn: 1,
    tokensOut: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    provider: "test",
    model: "test-model",
    errorKind: null,
    retryAfter: null,
  };
}

function makeCore(runChild: ChildRunner): OrchestrationCore {
  let n = 0;
  return new OrchestrationCore({
    runChild,
    idSource: () => {
      n += 1;
      return `leaf-${String(n)}`;
    },
    maxSubsessions: 100,
    maxParallel: 10,
    buildSubagentPrompt: () => "SYS",
  });
}

function causal(runId: string): CausalContext {
  return Object.freeze({
    runId,
    segmentId: "seg-1",
    nodePath: Object.freeze(["a"]),
    cellId: "a:0",
    role: "leaf",
    attempt: 0,
    turn: 0,
  });
}

function spawnRequest(runId: string): ChildSpawnRequest {
  return { prompt: "do it", causalContext: causal(runId) };
}

describe("ChildResult never carries forcedFallback (#403, decisão b: removido)", () => {
  it("OrchestrationChildRuntime.collect() never sets a forcedFallback key — the only real producer was the repass at orchestration-runtime.ts:223, now deleted", async () => {
    const runChild: ChildRunner = () => Promise.resolve(ok("done"));
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    const id = runtime.spawn(spawnRequest("run-1"));
    const result = await runtime.collect(id, { wait: true, timeoutSeconds: 5 });

    expect(result.status).toBe("complete");
    // RED on base: orchestration-runtime.ts:223 wrote `forcedFallback:
    // result.forcedFallback` unconditionally — even when the value is
    // `false`, the KEY is present. After the fix the key does not exist at
    // all: nothing computes a real value for it, so nothing should claim to.
    expect(Object.hasOwn(result, "forcedFallback")).toBe(false);
    // Sibling optional keys `collect()` DOES still compute are unaffected —
    // proves this is a targeted deletion, not an accidental payload wipe.
    expect(Object.hasOwn(result, "usageUncertain")).toBe(true);
    expect(Object.hasOwn(result, "sandboxRefusals")).toBe(true);
  });
});

describe("SpawnConfig.forcedTool reaches a REAL OrchestrationCore (#578: dropped at OrchestrationChildRuntime.spawn's own spread)", () => {
  it("OrchestrationChildRuntime.spawn repasses request.forcedTool through OrchestrationCore.spawn into the runChild callback — never a FakeRuntime", async () => {
    const captured: SpawnConfig[] = [];
    const runChild: ChildRunner = (_subId, config) => {
      captured.push(config);
      return Promise.resolve(ok("done"));
    };
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    const forcedTool = Object.freeze({ name: "StructuredOutput", schema: { type: "object" } });
    const id = runtime.spawn({ ...spawnRequest("run-forced-tool"), forcedTool });
    await runtime.collect(id, { wait: true, timeoutSeconds: 5 });

    // RED on base: orchestration-runtime.ts's spawn() built the SpawnConfig
    // literal without ever reading request.forcedTool — even though
    // ChildSpawnRequest (workflow/runtime.ts) already carried the field.
    // After the fix, the REAL core's own runChild callback receives it
    // verbatim, proving the fronteira named in the issue is closed — not
    // just a FakeRuntime's own `spawned[]` capture (tests/workflow-campos-
    // sem-efeito.test.ts:457, unaffected by this test).
    expect(captured[0]?.forcedTool).toEqual(forcedTool);
  });
});

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

describe("end-to-end: WorkflowEngine → OrchestrationChildRuntime → real OrchestrationCore → createChildRunner (#578, AC 3/4)", () => {
  it("a tool_less schema node whose leaf answers via StructuredOutput completes with forcing_fallbacks: 0 — the full production stack, never a FakeRuntime nor FakeChildRunner", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-forced-tool-e2e-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const port = new QueuePort([
      toolCallStream("StructuredOutput", '{"value":3}', "call_1"),
      // Second call is unforced (iteration 2) — the leaf just confirms in
      // prose; only the FIRST call's tool result feeds the schema.
      sseResponse([
        { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
    ]);
    const client = new ChatCompletionsClient({
      baseUrl: "http://parent.invalid/v1",
      apiKey: "lohra-local",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runChild = createChildRunner({
      sessions,
      parentSessionId: "parent-1",
      clientPool: pool,
      baseDispatch: () => Promise.resolve("should not be called"),
      parentToolDefinitions: [],
      defaultModel: "fake-model-a",
      cwd: "/tmp",
      idSource: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `child-${String(n)}`;
        };
      })(),
      clock: () => 1000,
      childMaxIterations: 50,
    });
    const runtime = new OrchestrationChildRuntime(
      new OrchestrationCore({
        runChild,
        idSource: (() => {
          let n = 0;
          return () => {
            n += 1;
            return `leaf-e2e-${String(n)}`;
          };
        })(),
        maxSubsessions: 100,
        maxParallel: 10,
        buildSubagentPrompt: () => "SYS",
      }),
    );
    const spec = validateSpec({
      meta: { name: "forced-tool-e2e" },
      nodes: [
        {
          id: "forced",
          type: "agent",
          prompt: "answer as JSON",
          tool_less: true,
          schema: { type: "object", properties: { value: { type: "integer" } } },
        },
      ],
    });
    if ("issues" in spec) throw new Error(spec.message);

    const result = await new WorkflowEngine({ runtime }).run(spec);

    // RED on base: `forcedTool` never reached `SpawnConfig` at all, so the
    // leaf's own request never carried a `tool_choice` — the model would
    // never be asked to call `StructuredOutput`, and this run would fall
    // back to parsing the leaf's plain text, bumping `forcing_fallbacks`.
    expect(result.status).toBe("complete");
    expect(result.outputs.forced).toEqual({ value: 3 });
    expect(result.forcingFallbacks).toBe(0);
    connection.close();
  });
});

describe("end-to-end: WorkflowEngine → OrchestrationChildRuntime → real OrchestrationCore → createChildRunner (#602)", () => {
  it("a steer-driven correction re-collect also reads the forced tool call, not the turn's prose — the node recovers with forcing_fallbacks: 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-forced-tool-recollect-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    const sessions = new SessionRepository(connection.database, () => 1000, connection.ftsEnabled);
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const port = new QueuePort([
      // Turn 1 (original spawn): the forced call answers with an INVALID
      // argument (a string where the schema wants an integer) — fails
      // `parseAndValidate` in `WorkflowEngine.collectLeaf`, which then
      // steers a correction into the same leaf.
      toolCallStream("StructuredOutput", '{"value":"nope"}', "call_1"),
      sseResponse([
        { choices: [{ delta: { content: "ack" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      // Turn 2 (steer resurrection, same session): `OrchestrationCore.steer`
      // resurrects the idle leaf with `{...entry.originalConfig, prompt:
      // text}` — `forcedTool` is part of `originalConfig`, so this turn's
      // own first iteration is forced again, this time with a VALID
      // argument.
      toolCallStream("StructuredOutput", '{"value":3}', "call_2"),
      sseResponse([
        { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      // Turn 3: never reached once the fix lands (attempt 1's re-collect
      // already validates via the tool call above and breaks the loop) —
      // present only so a RE-BROKEN base reproduces the documented fault
      // ("schema not satisfied after retries") instead of a queue
      // exhaustion, since a base without the fix keeps reading each turn's
      // own prose ("ack"/"done"/"done") and never validates, exhausting
      // `MAX_VALIDATION_RETRIES`.
      toolCallStream("StructuredOutput", '{"value":3}', "call_3"),
      sseResponse([
        { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
    ]);
    const client = new ChatCompletionsClient({
      baseUrl: "http://parent.invalid/v1",
      apiKey: "lohra-local",
      transport: new ChatCompletionsTransport(),
      http: port,
    });
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runChild = createChildRunner({
      sessions,
      parentSessionId: "parent-1",
      clientPool: pool,
      baseDispatch: () => Promise.resolve("should not be called"),
      parentToolDefinitions: [],
      defaultModel: "fake-model-a",
      cwd: "/tmp",
      idSource: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `child-recollect-${String(n)}`;
        };
      })(),
      clock: () => 1000,
      childMaxIterations: 50,
    });
    const runtime = new OrchestrationChildRuntime(
      new OrchestrationCore({
        runChild,
        idSource: (() => {
          let n = 0;
          return () => {
            n += 1;
            return `leaf-recollect-${String(n)}`;
          };
        })(),
        maxSubsessions: 100,
        maxParallel: 10,
        buildSubagentPrompt: () => "SYS",
      }),
    );
    const spec = validateSpec({
      meta: { name: "forced-tool-recollect" },
      nodes: [
        {
          id: "forced",
          type: "agent",
          prompt: "answer as JSON",
          tool_less: true,
          schema: { type: "object", properties: { value: { type: "integer" } } },
        },
      ],
    });
    if ("issues" in spec) throw new Error(spec.message);

    const result = await new WorkflowEngine({ runtime }).run(spec);

    // RED on base: `engine.ts`'s re-collect after `runtime.steer()` reads
    // `collected.output` verbatim (the correction turn's own prose, "done")
    // instead of re-running `extractForcedOutput` — `parseAndValidate` never
    // accepts that prose as the schema's object, so the node exhausts
    // `MAX_VALIDATION_RETRIES` and faults instead of returning the corrected
    // `{value: 3}` the leaf actually answered with, via the tool.
    expect(result.status).toBe("complete");
    expect(result.outputs.forced).toEqual({ value: 3 });
    expect(result.forcingFallbacks).toBe(0);
    expect(result.validationRetries).toBe(1);
    connection.close();
  });
});

describe("forcing_fallbacks only rises from the engine's own forced-schema fallback (#403)", () => {
  /** One leaf per spawn, scripted `collect()` results in call order — same
   * molde as `tests/workflow-fault-kinds.test.ts`'s `FakeRuntime`. The cast
   * lets a script smuggle a stray `forcedFallback` property past the
   * `ChildResult` type (which no longer declares it) — exactly what a
   * misbehaving or stale producer might still send; the engine has to
   * ignore it regardless of shape. */
  class FakeRuntime implements ChildRuntime {
    private readonly byId = new Map<string, ChildResult[]>();
    private readonly scripts: ChildResult[][];

    constructor(scripts: ChildResult[][]) {
      this.scripts = scripts.map((script) => [...script]);
    }

    spawn(request: ChildSpawnRequest): string {
      void request;
      const id = `leaf-${String(this.byId.size + 1)}`;
      this.byId.set(id, this.scripts.shift() ?? []);
      return id;
    }

    collect(id: string): ChildResult {
      const script = this.byId.get(id) ?? [];
      return script.shift() ?? { status: "failed", output: "script exhausted" };
    }

    steer(): void {}
    cancel(): void {}

    installLeafSandbox(): LeafSandboxHandle {
      return { dispose: (): void => undefined };
    }
  }

  function parsedSpec(raw: unknown) {
    const result = validateSpec(raw);
    if ("issues" in result) throw new Error(result.message);
    return result;
  }

  it("a leaf that reports a stray forcedFallback:true never increments forcing_fallbacks — only the engine's own StructuredOutput miss does", async () => {
    const rogue = {
      status: "complete",
      output: "ignored, no schema on this node",
      forcedFallback: true,
    } as unknown as ChildResult;
    const runtime = new FakeRuntime([[rogue]]);
    const spec = parsedSpec({
      meta: { name: "rogue-forced-fallback" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });

    const result = await new WorkflowEngine({ runtime }).run(spec);

    expect(result.status).toBe("complete");
    // RED on base: engine.ts:332 read `collected.forcedFallback === true`
    // and bumped the counter to 1 regardless of `usedFallback`. After the
    // fix, `forcingFallbacks` reads only `usedFallback` (engine's own
    // forced-schema miss, engine-utils.ts's extractForcedOutput) — a leaf
    // reporting an out-of-band `forcedFallback` never moves it.
    expect(result.forcingFallbacks).toBe(0);
  });
});

describe("usedFallback stays the 1st collect's own reading — a re-collect never recomputes it (#602 rodada 2)", () => {
  // Same molde as the #403 FakeRuntime above (one leaf per spawn, scripted
  // `collect()` results in call order) — local copy because that one is
  // scoped to its own `describe`. The revisor's veredito on PR #609 named
  // `forcing_fallbacks`'s contract explicitly out of #602's scope: a
  // steer-driven re-collect must re-extract `output` (the actual fix) but
  // never recompute `usedFallback` — main's own pre-#602 code always kept
  // it pinned to the FIRST collect (the loop only ever reassigned `output`,
  // straight off `collected.output`, never touching `usedFallback` again).
  class FakeRuntime implements ChildRuntime {
    private readonly byId = new Map<string, ChildResult[]>();
    private readonly scripts: ChildResult[][];

    constructor(scripts: ChildResult[][]) {
      this.scripts = scripts.map((script) => [...script]);
    }

    spawn(request: ChildSpawnRequest): string {
      void request;
      const id = `leaf-${String(this.byId.size + 1)}`;
      this.byId.set(id, this.scripts.shift() ?? []);
      return id;
    }

    collect(id: string): ChildResult {
      const script = this.byId.get(id) ?? [];
      return script.shift() ?? { status: "failed", output: "script exhausted" };
    }

    steer(): void {}
    cancel(): void {}

    installLeafSandbox(): LeafSandboxHandle {
      return { dispose: (): void => undefined };
    }
  }

  function parsedSpec(raw: unknown) {
    const result = validateSpec(raw);
    if ("issues" in result) throw new Error(result.message);
    return result;
  }

  const schema = Object.freeze({
    type: "object",
    properties: { value: { type: "integer" } },
    required: ["value"],
  });

  it("(a) 1st reply via the tool (invalid) → correction in PROSE (valid) → completes with forcing_fallbacks: 0, same as main", async () => {
    const runtime = new FakeRuntime([
      [
        // 1st collect: forced call fired, but the argument fails the
        // schema (a string where `value` wants an integer) — `usedFallback`
        // for THIS extraction is `false` (a StructuredOutput call WAS
        // found), and that's the reading that stays pinned.
        {
          status: "complete",
          output: "ignored — StructuredOutput's own arguments win",
          toolCalls: [{ id: "c1", name: "StructuredOutput", arguments: '{"value":"nope"}' }],
        },
        // Re-collect after steer: the correction landed as plain prose
        // (no tool call at all) — schema-valid JSON text. The FIX re-reads
        // this collect's own `output` (this is what makes the node
        // recover); `usedFallback` is never touched again.
        { status: "complete", output: '{"value":5}' },
      ],
    ]);
    const spec = parsedSpec({
      meta: { name: "recollect-prose-after-tool" },
      nodes: [{ id: "a", type: "agent", prompt: "x", tool_less: true, schema }],
    });

    const result = await new WorkflowEngine({ runtime }).run(spec);

    // RED on a version that recomputes `usedFallback` on every collect (the
    // PR #609 r1 shape, `({ output, usedFallback } = extractForcedOutput(...))`):
    // this re-collect finds no tool call, so THAT extraction's own
    // `usedFallback` is `true` — overwriting the pinned `false` and bumping
    // `forcingFallbacks` to 1, a contract change #602 explicitly rules out
    // of scope.
    expect(result.status).toBe("complete");
    expect(result.outputs.a).toEqual({ value: 5 });
    expect(result.validationRetries).toBe(1);
    expect(result.forcingFallbacks).toBe(0);
  });

  it("(b) 1st reply in PROSE (invalid) → correction via the tool (valid) → completes with forcing_fallbacks: 1 — the 1st reading's fallback sticks", async () => {
    const runtime = new FakeRuntime([
      [
        // 1st collect: no tool call at all (forced, but the leaf answered
        // in prose) — invalid JSON, so validation fails and a correction is
        // steered. `usedFallback` for THIS extraction is `true`; that's the
        // pinned value the node keeps to the end.
        { status: "complete", output: "not valid json at all" },
        // Re-collect after steer: this time the leaf calls the tool with a
        // valid argument — the fix's re-extraction picks this call's
        // argument as `output`, letting the node recover, but the
        // `usedFallback` pinned above is untouched.
        {
          status: "complete",
          output: "ignored — StructuredOutput's own arguments win",
          toolCalls: [{ id: "c2", name: "StructuredOutput", arguments: '{"value":5}' }],
        },
      ],
    ]);
    const spec = parsedSpec({
      meta: { name: "recollect-tool-after-prose" },
      nodes: [{ id: "a", type: "agent", prompt: "x", tool_less: true, schema }],
    });

    const result = await new WorkflowEngine({ runtime }).run(spec);

    expect(result.status).toBe("complete");
    expect(result.outputs.a).toEqual({ value: 5 });
    expect(result.validationRetries).toBe(1);
    expect(result.forcingFallbacks).toBe(1);
  });
});

describe("audit ledger + workflow_status: forced_fallback never appears, forcing_fallbacks unaffected (#403)", () => {
  function harness() {
    const root = mkdtempSync(join(tmpdir(), "lohra-forced-fallback-audit-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    const repository = new WorkflowRepository(connection.database);
    const locks = new LockRepository(connection.database);
    const audit = new AuditRepository(connection.database);
    const trail = new AuditTrail(audit);
    const ownership = { fence: 0, holder: "test", now: 1000 };
    const store: OwnershipStore = {
      repository,
      locks,
      holder: "test",
      ttl: 900,
      ownershipOf: () => ownership,
      database: connection.database,
    };
    const runtime: ChildRuntime = {
      spawn: (() => {
        let seq = 0;
        return () => {
          seq += 1;
          return `leaf-${String(seq)}`;
        };
      })(),
      collect: () => ({ status: "complete", output: "pong" }),
      steer: () => undefined,
      cancel: () => undefined,
      installLeafSandbox: () => ({ dispose: (): void => undefined }),
    };
    const service = new WorkflowService({ runtime, auditTrail: trail, store });
    return {
      service,
      audit,
      close: (): void => {
        connection.close();
      },
    };
  }

  it("leaf.completed's audit payload never carries forced_fallback, and workflow_status's forcing_fallbacks is unaffected", async () => {
    const { service, audit, close } = harness();
    try {
      const started = service.start({
        meta: { name: "audit-forced-fallback" },
        nodes: [{ id: "a", type: "agent", prompt: "hi" }],
      });
      if ("error" in started) throw new Error(started.error);
      const status = await service.status(started.run_id, true);

      const page = audit.query({ runId: started.run_id, limit: 50 });
      const completed = page.events.find((event) => event.event_type === "leaf.completed");
      if (completed === undefined) throw new Error("no leaf.completed event recorded");

      // RED on base: audit-runtime.ts:251 always wrote `forced_fallback:
      // result.forcedFallback === true` — present (as `false`) even though
      // no producer ever made it true. After the fix the key is gone
      // entirely, while its sibling `usage_uncertain` (a real, still-wired
      // field) proves this isn't an accidental full-payload wipe.
      expect(Object.hasOwn(completed.data, "forced_fallback")).toBe(false);
      expect(Object.hasOwn(completed.data, "usage_uncertain")).toBe(true);

      // Propagation to workflow_status (service-rollup.ts's resultView,
      // untouched by this fix): forcing_fallbacks stays wired to the
      // engine's own counter, unaffected by removing the dead field.
      expect(status).not.toBeNull();
      expect((status as Readonly<Record<string, unknown>>).forcing_fallbacks).toBe(0);
    } finally {
      close();
    }
  });
});
