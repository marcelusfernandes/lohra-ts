// Issue #452 (M14, follow-up do épico #421, achado de revisão da PR #442,
// rodada 2 da PR #472): `runNested` (`src/workflow/engine.ts:832+`) carrega
// o template de um nó `workflow` por `ref` em runtime, via
// `this.loader(reference)` — DEPOIS que `pivotResume`
// (`route-override.ts`, #427) já reescreveu a espec de NÍVEL SUPERIOR de um
// resume. Um pivô de rota (`run_workflow(resume_run_id, route)`) nunca
// alcançava a rota de um nó DENTRO desse template: a folha aninhada
// pausada por `route_fault` pausava de novo, idêntica, consumindo um dos 3
// pivôs à toa.
//
// Rodada 1 (commit 410a4a64) só provava a mecânica construindo o
// `WorkflowEngine` à mão — `service.ts` (os dois pontos que constroem o
// engine de verdade, `launch`/`launchDurable`) não passava
// `options.routeOverride` a `engineBaseOptions`, então em produção o pivô
// nunca alcançava o engine. O revisor reprovou por isso (veredito na PR
// #472); 3ª emenda da issue #452 trouxe `service.ts` para os `Files` só
// para esse threading. O teste principal abaixo agora sobe a cadeia real —
// `WorkflowService.start`/`resume` — molde
// `tests/workflow-route-override.test.ts` (#427), com `loader` injetado no
// construtor do serviço (o loader real de `ref` em produção ainda não está
// ligado — #464, M11 — mas o CAMINHO de threading do pivô é o mesmo).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
} from "../src/state/index.js";
import { auditedWorkflowCache } from "../src/workflow/audit-cache.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { MemoryWorkflowCache } from "../src/workflow/cache.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { durableFromRow, durableRollup, WorkflowService } from "../src/workflow/service.js";
import { validateSpec } from "../src/workflow/schema.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
} from "../src/workflow/runtime.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const USAGE = {
  inputTokens: 3,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

/** Molde de `RoutingFakeRuntime` (`tests/workflow-route-override.test.ts`,
 * #427) — duplicado, não importado: aquele arquivo está no teto de 800
 * linhas (emenda 2026-09-13 da issue #452) e não pode ganhar um export
 * novo sem crescer. One leaf per spawn; `collect()` refuses with
 * `auth_failed` whenever the spawned request's provider is (still) the
 * bad one — same `route_fault` mapping `route-faults.ts` already gives
 * that error kind. */
class RoutingFakeRuntime implements ChildRuntime {
  private seq = 0;
  private readonly providerById = new Map<string, string | null>();

  constructor(private readonly badProvider: string) {}

  spawn(request: ChildSpawnRequest): string {
    this.seq += 1;
    const id = `leaf-${String(this.seq)}`;
    this.providerById.set(id, request.provider ?? null);
    return id;
  }

  collect(id: string, _options: ChildCollectOptions): ChildResult {
    const provider = this.providerById.get(id) ?? null;
    if (provider === this.badProvider) {
      return {
        status: "failed",
        output: "boom",
        errorKind: "auth_failed",
        retryAfter: null,
        provider,
        model: "m-bad",
      };
    }
    return { status: "complete", output: { ok: true }, usage: USAGE, provider, model: "m-good" };
  }

  steer(): void {}
  cancel(): void {}

  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

/** The `ref` target — one node with no route (replays untouched by a
 * pivot) and one PINNED to a provider `RoutingFakeRuntime` always refuses,
 * so the FIRST run pauses right there. `this.loader` (engine.ts) re-reads
 * this same object EVERY call, exactly like a real file-backed template —
 * a pivot has to rewrite it at runtime, on the way in, not on disk. */
function childTemplate(): Record<string, unknown> {
  return {
    meta: { name: "nested-child" },
    nodes: [
      { id: "free", type: "agent", prompt: "unpinned" },
      { id: "pinned", type: "agent", prompt: "pinned", provider: "bad-provider" },
    ],
  };
}

function parentSpecRaw(): Record<string, unknown> {
  return {
    meta: { name: "nested-parent" },
    nodes: [{ id: "sub", type: "workflow", ref: "child" }],
  };
}

function parentSpec() {
  return parsed(parentSpecRaw());
}

/** `WorkflowService` harness — molde `tests/workflow-route-override.test.ts`
 * (#427), com `loader` injetado no construtor: o único jeito, hoje, de dar
 * a um `workflow` node por `ref` um template SEM depender do loader real de
 * produção (#464, M11, ainda não ligado). */
function serviceHarness(runtime: ChildRuntime) {
  const root = mkdtempSync(join(tmpdir(), "lohra-route-override-nested-service-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const ownership = { fence: 0 as number, holder: "test", now: 1000 };
  const store = {
    repository,
    locks,
    holder: "test",
    ttl: 900,
    ownershipOf: () => ownership,
    database: connection.database,
  };
  const service = new WorkflowService({
    runtime,
    auditTrail: trail,
    store,
    loader: () => childTemplate(),
  });
  return {
    service,
    repository,
    close: (): void => {
      connection.close();
    },
  };
}

/** Engine-level harness for the contra-assertion below ONLY — the AC test
 * above goes through `WorkflowService`. Same `runId` + shared cache between
 * two `WorkflowEngine` constructions simulates a resume without a pivot
 * (molde `tests/workflow-parallel-cells.test.ts`, #332/#348). */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "lohra-route-override-nested-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const inner = new MemoryWorkflowCache();
  return {
    cacheFor: (segmentId: string) =>
      auditedWorkflowCache(inner, {
        trail,
        ownershipOf: () => null,
        durable: false,
        warn: () => undefined,
        segmentId,
      }),
    close: (): void => {
      connection.close();
    },
  };
}

describe("run_workflow(resume_run_id, route) reaches a sub-workflow by ref — cadeia real (#452 AC)", () => {
  it("WorkflowService.start → pause por route_fault na folha aninhada → resume com route completa o run; pivots com 1 entrada", async () => {
    const { service, repository, close } = serviceHarness(new RoutingFakeRuntime("bad-provider"));
    try {
      const started = service.start(parentSpecRaw());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(durableFromRow(line).pause_reason).toBe("route_fault");

      const routeOverride = { provider: "good" };
      const resumed = service.start(null, {}, { resumeRunId: started.run_id, routeOverride });
      if ("error" in resumed) throw new Error(resumed.error);
      const live = await service.status(started.run_id, true);
      if ("error" in live) throw new Error(String(live.error));
      expect(live.status).toBe("complete");
      expect(live.outputs).toEqual({ sub: { free: { ok: true }, pinned: { ok: true } } });

      const resumedLine = repository.getRunState(started.run_id) as Record<string, unknown>;
      const resumedView = durableFromRow(resumedLine);
      expect(resumedView.status).toBe("complete");

      // #427/#448: `pivots` accrues on the DURABLE row across the resume —
      // proves the override actually reached `service.ts`'s bookkeeping,
      // not just `engine.ts`'s own field.
      const rollup = durableRollup(resumedView, 0, false);
      expect(rollup.pivots).toEqual([routeOverride]);
    } finally {
      close();
    }
  });

  it("without a route override, a resume's reload of the SAME template pauses again (contra-asserção)", async () => {
    const { cacheFor, close } = harness();
    try {
      const runtime = new RoutingFakeRuntime("bad-provider");
      const runId = "nested-no-pivot-run";
      const options = { runtime, cache: cacheFor("seg-1"), runId, loader: () => childTemplate() };
      const first = await new WorkflowEngine(options).run(parentSpec());
      expect(first.status).toBe("paused");
      const second = await new WorkflowEngine(options).run(parentSpec());
      expect(second.status).toBe("paused");
      expect(second.pauseReason).toBe("route_fault");
    } finally {
      close();
    }
  });
});

describe("overrideNestedSpec — the pure rewrite runNested applies (#452)", () => {
  it("undefined returns the SAME spec reference; a defined override rewrites only nodes that declare a route", async () => {
    // New symbol (route-override.ts) — dynamic import inside `it`, same
    // convention `tests/workflow-route-override.test.ts` uses for #427's
    // module: isolates the failure to THIS test on a base that doesn't
    // export it yet, instead of crashing collection for the whole file.
    const { overrideNestedSpec } = await import("../src/workflow/route-override.js");
    const spec = parsed(childTemplate());
    expect(overrideNestedSpec(spec, undefined)).toBe(spec);
    const rewritten = overrideNestedSpec(spec, { provider: "good" });
    expect(rewritten).not.toBe(spec);
    expect(rewritten.nodes.find((node) => node.id === "pinned")?.fields.provider).toBe("good");
    expect(rewritten.nodes.find((node) => node.id === "free")).toBe(
      spec.nodes.find((node) => node.id === "free"),
    );
  });
});
