// Issue #452 (M14, follow-up do épico #421, achado de revisão da PR #442):
// `runNested` (`src/workflow/engine.ts:832+`) carrega o template de um nó
// `workflow` por `ref` em runtime, via `this.loader(reference)` — DEPOIS que
// `pivotResume` (`route-override.ts`, #427) já reescreveu a espec de NÍVEL
// SUPERIOR de um resume. Um pivô de rota (`run_workflow(resume_run_id,
// route)`) nunca alcançava a rota de um nó DENTRO desse template: a folha
// aninhada pausada por `route_fault` pausava de novo, idêntica, consumindo
// um dos 3 pivôs à toa.
//
// Harness deliberadamente ao nível do `WorkflowEngine` — molde
// `tests/workflow-parallel-cells.test.ts` (#332/#348: mesmo `runId` + cache
// compartilhado entre duas construções simula um resume) — não via
// `WorkflowService`: `service.ts` não está nos `Files` desta issue (a opção
// (a) do despacho exige threading em `service.ts`/`engine-contract.ts` que
// não foi incluído; comentário na issue #452 registra o gap). A cache é
// REAL: `auditedWorkflowCache` (#368) sobre um `AuditRepository` SQLite de
// verdade — molde `tests/workflow-route-override.test.ts` (#427) para o
// ledger `cache.*`, construído aqui diretamente em vez de via
// `producers.wrapCache` (implementação de `service.ts`).
//
// Na base (main), `WorkflowEngineOptions` não tem `routeOverride` — a
// segunda construção do engine abaixo passa a opção, mas nada na base a lê
// (JS não valida a forma em runtime; a propriedade extra é simplesmente
// ignorada) — o template recarregado roda de nov na MESMA rota velha: o run
// pausa de novo em vez de completar. RED por asserção (`second.status` fica
// `"paused"`, nunca `"complete"`), não por erro estrutural.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditRepository, openStateDatabase } from "../src/state/index.js";
import { auditedWorkflowCache } from "../src/workflow/audit-cache.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { MemoryWorkflowCache } from "../src/workflow/cache.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { nextPivots } from "../src/workflow/route-override.js";
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

function parentSpec() {
  return parsed({
    meta: { name: "nested-parent" },
    nodes: [{ id: "sub", type: "workflow", ref: "child" }],
  });
}

/** Real cache-audit ledger (#368), built directly instead of through
 * `WorkflowService`'s `producers.wrapCache` — `cacheFor` decorates the SAME
 * underlying `MemoryWorkflowCache` with a DIFFERENT `segmentId` per engine
 * construction, so a query scoped to one segment sees only that
 * construction's own `cache.*` events (same segmentation
 * `tests/workflow-route-override.test.ts` gets for free from
 * `WorkflowService`'s per-acquisition segment id). */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "lohra-route-override-nested-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const inner = new MemoryWorkflowCache();
  return {
    audit,
    trail,
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

describe("a resume's route override reaches a sub-workflow by ref (#452 AC)", () => {
  it("the nested leaf runs on the NEW route; unpinned replays, pinned recomputes, run completes", async () => {
    const { audit, trail, cacheFor, close } = harness();
    try {
      const runtime = new RoutingFakeRuntime("bad-provider");
      const runId = "nested-pivot-run";

      const first = await new WorkflowEngine({
        runtime,
        cache: cacheFor("seg-1"),
        runId,
        loader: () => childTemplate(),
      }).run(parentSpec());
      expect(first.status).toBe("paused");
      expect(first.pauseReason).toBe("route_fault");

      const routeOverride = { provider: "good" };
      const second = await new WorkflowEngine({
        runtime,
        cache: cacheFor("seg-2"),
        runId,
        loader: () => childTemplate(),
        routeOverride,
      }).run(parentSpec());
      expect(second.status).toBe("complete");
      expect(second.outputs.sub).toEqual({ free: { ok: true }, pinned: { ok: true } });

      await trail.flush();
      const page = audit.query({ runId, segmentId: "seg-2", limit: 50 });
      // `cacheGet` (engine.ts) scopes `nodeId` with `scopedCheckpointId` —
      // "sub.free"/"sub.pinned" — but every `cachePut` call site passes the
      // bare `node.id` instead (pre-existing, out of #452's scope: neither
      // `engine.ts:456` nor its siblings are touched here); `cache.stored`
      // for a nested leaf lands on the UNSCOPED path. `matchesLeaf` reads
      // through that quirk instead of hiding it.
      const matchesLeaf = (nodePath: string | undefined, leafId: string): boolean =>
        nodePath === leafId || nodePath === `sub.${leafId}`;
      const eventTypesFor = (leafId: string): readonly string[] =>
        page.events
          .filter((event) =>
            matchesLeaf((event.identity.node_path as readonly string[] | undefined)?.[0], leafId),
          )
          .map((event) => event.event_type)
          .filter((type) => type.startsWith("cache."));
      expect(eventTypesFor("free")).toEqual(["cache.replayed"]);
      expect(eventTypesFor("pinned")).toEqual(["cache.missed", "cache.stored"]);

      expect(nextPivots([], routeOverride)).toEqual([routeOverride]);
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
