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
// `src/orchestration/core.ts` (`CollectResult.forcedFallback: boolean`) e
// `src/orchestration/tools.ts` (o envelope `delegate_task`, 13 chaves
// pinadas, ADR 0003) NÃO mudam — nunca foram o campo morto; o campo morto
// era só o repasse em `orchestration-runtime.ts`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OrchestrationCore,
  type ChildRunner,
  type CollectResult,
} from "../src/orchestration/core.js";
import {
  openStateDatabase,
  WorkflowRepository,
  LockRepository,
  AuditRepository,
} from "../src/state/index.js";
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
    forcedFallback: false,
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
