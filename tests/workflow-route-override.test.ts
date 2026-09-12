// Issue #427 (M10-S6, épico #421): molde tests/workflow-route-faults.test.ts
// (S5, #426) e tests/workflow-audit-cache.test.ts (#368) para o AC desta
// issue — `run_workflow(resume_run_id, route: {provider?, model?})`
// re-escreve a rota de todo nó (e stage de pipeline) que a declara, nós sem
// pino replayam do cache (`cache.replayed`), o nó pinado re-executa na rota
// nova (`cache.missed`/`cache.stored`), e um teto de
// `MAX_ROUTE_PIVOTS_PER_RUN` pivôs por run é aplicado no resume.
//
// Na base (main), `route` não existe em lugar nenhum: `WorkflowTool.run`
// ignora silenciosamente o campo, `WorkflowLaunchOptions` não tem
// `routeOverride`, e um resume tenta sempre a MESMA rota — um nó pausado por
// `route_fault` pausa de novo, idêntico, em vez de completar na rota nova.
// Os blocos que exercitam `route-override.ts` diretamente (módulo ainda
// inexistente na base) usam import dinâmico DENTRO de cada `it`, isolando a
// falha de módulo por teste (mesmo padrão do commit test(red) da #426).
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
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { durableFromRow, durableRollup, WorkflowService } from "../src/workflow/service.js";
import { workflowToolHandlers } from "../src/workflow/tool.js";
import type { ToolArguments, ToolHandler } from "../src/tools/types.js";
import {
  validateSpec,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
} from "../src/workflow/index.js";

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

/** One leaf per spawn — `collect()` fails with `auth_failed` whenever the
 * spawned request's `provider` is (still) `badProvider`, and completes
 * otherwise. Shared by every test below so a resume that actually pivots
 * the route can be told apart from one that keeps refusing. */
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

function harness(runtime: ChildRuntime) {
  const root = mkdtempSync(join(tmpdir(), "lohra-route-override-"));
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
  const service = new WorkflowService({ runtime, auditTrail: trail, store });
  return {
    service,
    repository,
    audit,
    close: (): void => {
      connection.close();
    },
  };
}

/** `run_workflow`'s own handler always resolves synchronously (it never
 * awaits anything) — this just tolerates `ToolHandler`'s general
 * `string | Promise<string>` shape and the index-signature `| undefined`
 * `noUncheckedIndexedAccess` adds to a plain `handlers.run_workflow` read. */
function runWorkflowTool(
  handlers: Readonly<Record<string, ToolHandler>>,
  args: ToolArguments,
): unknown {
  const handler = handlers.run_workflow;
  if (handler === undefined) throw new Error("missing run_workflow handler");
  const out = handler(args);
  if (typeof out !== "string") throw new Error("run_workflow did not resolve synchronously");
  return JSON.parse(out);
}

function segmentIdOf(repository: WorkflowRepository, runId: string): string {
  const row = repository.getRunState(runId) as Record<string, unknown>;
  return String(row.audit_segment_id);
}

function cacheSpec(): Record<string, unknown> {
  return {
    meta: { name: "route-override-cache" },
    nodes: [
      { id: "free", type: "agent", prompt: "unpinned" },
      { id: "pinned", type: "agent", prompt: "pinned", provider: "bad-provider" },
    ],
  };
}

describe("run_workflow(resume_run_id, route) — cache real (#427 AC)", () => {
  it("a route pivot on resume replays the UNPINNED node's cache and re-spawns only the PINNED one, on the new route", async () => {
    const { service, repository, audit, close } = harness(new RoutingFakeRuntime("bad-provider"));
    try {
      const started = service.start(cacheSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(durableFromRow(line).pause_reason).toBe("route_fault");
      const firstSegment = segmentIdOf(repository, started.run_id);
      const firstFree = audit
        .query({ runId: started.run_id, segmentId: firstSegment, limit: 50 })
        .events.filter(
          (event) =>
            event.event_type.startsWith("cache.") &&
            (event.identity.node_path as readonly string[] | undefined)?.[0] === "free",
        );
      expect(firstFree.map((event) => event.event_type)).toEqual(["cache.missed", "cache.stored"]);

      const resumeOptions = { resumeRunId: started.run_id, routeOverride: { provider: "good" } };
      const resumed = service.start(null, {}, resumeOptions);
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      const resumedLine = repository.getRunState(started.run_id) as Record<string, unknown>;
      const resumedView = durableFromRow(resumedLine);
      expect(resumedView.status).toBe("complete");

      const secondSegment = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, segmentId: secondSegment, limit: 50 });
      const freeEvents = page.events.filter(
        (event) =>
          event.event_type.startsWith("cache.") &&
          (event.identity.node_path as readonly string[] | undefined)?.[0] === "free",
      );
      const pinnedEvents = page.events.filter(
        (event) =>
          event.event_type.startsWith("cache.") &&
          (event.identity.node_path as readonly string[] | undefined)?.[0] === "pinned",
      );
      expect(freeEvents.map((event) => event.event_type)).toEqual(["cache.replayed"]);
      expect(pinnedEvents.map((event) => event.event_type)).toEqual([
        "cache.missed",
        "cache.stored",
      ]);
    } finally {
      close();
    }
  });

  it("workflow_status's durable rollup exposes 'pivots' once a route has been overridden", async () => {
    const { service, repository, close } = harness(new RoutingFakeRuntime("bad-provider"));
    try {
      const started = service.start(cacheSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const resumeOptions = { resumeRunId: started.run_id, routeOverride: { provider: "good" } };
      const resumed = service.start(null, {}, resumeOptions);
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      const view = durableFromRow(line);
      const rollup = durableRollup(view, 0, false);
      expect(rollup.pivots).toEqual([{ provider: "good" }]);
    } finally {
      close();
    }
  });
});

describe("run_workflow(resume_run_id, route) — pivot cap (#427 AC)", () => {
  it("refuses a route override without resume_run_id, named error", () => {
    const { service, close } = harness(new RoutingFakeRuntime("bad-provider"));
    try {
      const handlers = workflowToolHandlers(service);
      const out = runWorkflowTool(handlers, {
        spec: cacheSpec(),
        route: { provider: "good" },
      }) as { error?: string };
      expect(out.error ?? "").toContain("resume_run_id");
    } finally {
      close();
    }
  });

  it("refuses a route override that names neither provider nor model", () => {
    const { service, close } = harness(new RoutingFakeRuntime("bad-provider"));
    try {
      const started = service.start(cacheSpec());
      if ("error" in started) throw new Error(started.error);
      const handlers = workflowToolHandlers(service);
      const out = runWorkflowTool(handlers, {
        resume_run_id: started.run_id,
        route: {},
      }) as { error?: string };
      expect(out.error ?? "").toContain("route");
    } finally {
      close();
    }
  });

  it("a run pivots route at most 3 times — the 4th resume with 'route' is refused, naming the cap", async () => {
    // Every provider this test tries is still `badProvider` for the NEXT
    // pivot, so the run keeps pausing with route_fault after each one —
    // the honest way to grow `pivots` across real pause/resume cycles.
    const { service, repository, close } = harness(new RoutingFakeRuntime("always-bad"));
    try {
      const started = service.start({
        meta: { name: "route-override-cap" },
        nodes: [{ id: "a", type: "agent", prompt: "x", provider: "always-bad" }],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      for (const provider of ["v1", "v2", "v3"]) {
        const resumeOptions = { resumeRunId: started.run_id, routeOverride: { provider } };
        const resumed = service.start(null, {}, resumeOptions);
        if ("error" in resumed) throw new Error(resumed.error);
        await service.status(started.run_id, true);
      }
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(durableFromRow(line).pivots).toHaveLength(3);
      const fourthOptions = { resumeRunId: started.run_id, routeOverride: { provider: "v4" } };
      const fourth = service.start(null, {}, fourthOptions);
      expect("error" in fourth).toBe(true);
      if ("error" in fourth) expect(fourth.error).toContain("3");
    } finally {
      close();
    }
  });
});

// Issue #447 (M14, follow-up of #442's review): on the base, `route`'s type
// check only asks whether `provider`/`model` ARE strings, never whether
// they're non-empty — `route: {provider: ""}` sails through, gets written
// onto every node that declares a route (`applyRouteOverrideToSpec`), and
// PERSISTS in `spec_json` before the doomed spawn even starts, burning one
// of the run's 3 pivots on a typo. These tests check the boundary refuses
// an empty/whitespace-only value BEFORE the run is ever touched — same
// `cacheSpec()`/`RoutingFakeRuntime` harness as the pivot-cap block above,
// paused on 'route_fault' first so there's a real, comparable "before"
// state to assert stays byte-for-byte the same after the refusal.
describe("run_workflow(resume_run_id, route) — provider/model must be non-empty (#447 AC)", () => {
  async function pausedOnRouteFault() {
    const harnessed = harness(new RoutingFakeRuntime("bad-provider"));
    const started = harnessed.service.start(cacheSpec());
    if ("error" in started) throw new Error(started.error);
    await harnessed.service.status(started.run_id, true);
    const before = harnessed.repository.getRunState(started.run_id) as Record<string, unknown>;
    expect(durableFromRow(before).pause_reason).toBe("route_fault");
    return { ...harnessed, runId: started.run_id, before };
  }

  it("refuses route.provider as an empty string, named error, without touching the run", async () => {
    const { service, repository, runId, before, close } = await pausedOnRouteFault();
    try {
      const handlers = workflowToolHandlers(service);
      const out = runWorkflowTool(handlers, {
        resume_run_id: runId,
        route: { provider: "" },
      }) as { error?: string };
      expect(out.error ?? "").toContain("route.provider");
      expect(out.error ?? "").toContain("non-empty");
      const after = repository.getRunState(runId) as Record<string, unknown>;
      expect(after).toEqual(before);
      expect(durableFromRow(after).pivots).toEqual([]);
    } finally {
      close();
    }
  });

  it("refuses route.model as whitespace-only, named error, without touching the run", async () => {
    const { service, repository, runId, before, close } = await pausedOnRouteFault();
    try {
      const handlers = workflowToolHandlers(service);
      const out = runWorkflowTool(handlers, {
        resume_run_id: runId,
        route: { model: "   " },
      }) as { error?: string };
      expect(out.error ?? "").toContain("route.model");
      expect(out.error ?? "").toContain("non-empty");
      const after = repository.getRunState(runId) as Record<string, unknown>;
      expect(after).toEqual(before);
      expect(durableFromRow(after).pivots).toEqual([]);
    } finally {
      close();
    }
  });

  it("refuses route.provider as an empty string even when route.model is set, named error", async () => {
    const { service, repository, runId, before, close } = await pausedOnRouteFault();
    try {
      const handlers = workflowToolHandlers(service);
      const out = runWorkflowTool(handlers, {
        resume_run_id: runId,
        route: { provider: "", model: "x" },
      }) as { error?: string };
      expect(out.error ?? "").toContain("route.provider");
      const after = repository.getRunState(runId) as Record<string, unknown>;
      expect(after).toEqual(before);
      expect(durableFromRow(after).pivots).toEqual([]);
    } finally {
      close();
    }
  });

  it("still accepts route.provider as a normal non-empty string (non-regression)", async () => {
    const { service, runId, close } = await pausedOnRouteFault();
    try {
      const handlers = workflowToolHandlers(service);
      const out = runWorkflowTool(handlers, {
        resume_run_id: runId,
        route: { provider: "good" },
      }) as { error?: string };
      expect(out.error).toBeUndefined();
    } finally {
      close();
    }
  });
});

// Issue #446 (M14, follow-up of #427/PR #442's review): the stretch's own
// REGISTRATION write (and the per-node progress write, #125) used to
// hardcode `pause_payload_json: null` — only the TERMINAL write folded
// `pivots` in (`pausePayloadOf`). A process that crashed anywhere between
// either of those `null` writes and the terminal one lost the whole pivot
// history on the next read, silently resetting the de facto human gate of
// `MAX_ROUTE_PIVOTS_PER_RUN`.
//
// `tests/workers/` (workflow-launch-worker.ts / workflow-resume-worker.ts,
// spawned as real OS processes in workflow-cross-process.test.ts) cannot
// exercise this: neither worker accepts a `route` override, and adding one
// is out of this issue's `Files`. Instead this mirrors the established
// in-repo technique for the SAME class of problem —
// `workflow-service-durability.test.ts:786-852` ("two SERVICES, one
// holder — the same shape as two processes"): two separate `WorkflowService`
// instances sharing one physical `state.db`/lock table (never the same
// in-memory `this.runs` registry), one of them holding a leaf's `collect()`
// open forever so its stretch's `engine.run()` never settles and its
// terminal write never lands — a crash in every way that matters to the
// durable row this issue is about.
describe("pivots survive a crash between a stretch's registration/progress writes and its terminal write (#446)", () => {
  const USAGE = {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };

  /** Every leaf completes immediately — used to cheaply establish pivots
   * BEFORE the crash (each override changes "pinned"'s cache identity, so
   * every resume below is a real re-execution, not a cache replay). */
  class AlwaysCompleteRuntime implements ChildRuntime {
    private seq = 0;
    spawn(): string {
      this.seq += 1;
      return `leaf-${String(this.seq)}`;
    }
    collect(): ChildResult {
      return { status: "complete", output: { ok: true }, usage: USAGE };
    }
    steer(): void {}
    cancel(): void {}
    installLeafSandbox(): { dispose: () => void } {
      return { dispose: (): void => undefined };
    }
  }

  /** The crash: "pinned"'s `collect()` never resolves, so `engine.run()`
   * never settles and the stretch's terminal write never lands. "free" has
   * no route fields, so it never calls this runtime at all — it is already
   * cached from the setup stretches above and just replays. */
  class HangingPinnedRuntime implements ChildRuntime {
    spawn(): string {
      return "leaf-hanging";
    }
    collect(): Promise<ChildResult> {
      return new Promise<ChildResult>(() => undefined);
    }
    steer(): void {}
    cancel(): void {}
    installLeafSandbox(): { dispose: () => void } {
      return { dispose: (): void => undefined };
    }
  }

  function twoNodeSpec(): Record<string, unknown> {
    return {
      meta: { name: "route-override-crash" },
      nodes: [
        { id: "free", type: "agent", prompt: "unpinned" },
        { id: "pinned", type: "agent", prompt: "pinned", provider: "p0" },
      ],
    };
  }

  it("a crashed stretch's registration/progress writes carry 'pivots' forward — the 4th pivot stays refused after a fresh process resumes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-route-override-crash-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const clock = { now: 1000 };
      const ttl = 10;
      const store = () => ({
        repository,
        locks,
        holder: "same-holder",
        ttl,
        ownershipOf: () => ({ fence: 0, holder: "same-holder", now: clock.now }),
        database: connection.database,
      });

      // --- setup: 2 pivots, via real pause/resume cycles, before the crash ---
      const initial = new WorkflowService({
        runtime: new AlwaysCompleteRuntime(),
        auditTrail: trail,
        store: store(),
      });
      const started = initial.start(twoNodeSpec());
      if ("error" in started) throw new Error(started.error);
      await initial.status(started.run_id, true);
      expect(
        durableFromRow(repository.getRunState(started.run_id) as Record<string, unknown>).pivots,
      ).toHaveLength(0);

      for (const provider of ["v1", "v2"]) {
        const resumeService = new WorkflowService({
          runtime: new AlwaysCompleteRuntime(),
          auditTrail: trail,
          store: store(),
        });
        const resumed = resumeService.start(
          null,
          {},
          {
            resumeRunId: started.run_id,
            routeOverride: { provider },
          },
        );
        if ("error" in resumed) throw new Error(resumed.error);
        await resumeService.status(started.run_id, true);
      }
      const beforeCrash = durableFromRow(
        repository.getRunState(started.run_id) as Record<string, unknown>,
      );
      expect(beforeCrash.pivots).toEqual([{ provider: "v1" }, { provider: "v2" }]);
      expect(beforeCrash.status).toBe("complete");

      // --- the crash: a 3rd pivot's stretch registers, "free" replays and
      // fires its own progress write (#125), then "pinned" hangs forever ---
      let freeCompletedResolve: () => void = () => undefined;
      const freeCompleted = new Promise<void>((resolve) => {
        freeCompletedResolve = resolve;
      });
      const crashService = new WorkflowService({
        runtime: new HangingPinnedRuntime(),
        auditTrail: trail,
        store: store(),
        onEvent: (event) => {
          if (event.kind === "node" && event.nodeId === "free" && event.state !== "running") {
            freeCompletedResolve();
          }
        },
      });
      const crashed = crashService.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          routeOverride: { provider: "v3" },
        },
      );
      if ("error" in crashed) throw new Error(crashed.error);
      // "free"'s own completion event (and the persist it triggers, #125)
      // fires synchronously ahead of this promise's continuation — by the
      // time `await` resumes, that write has already landed.
      await freeCompleted;
      const midCrashRow = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(midCrashRow.status).toBe("running"); // never reached the terminal write
      expect(JSON.parse(String(midCrashRow.pause_payload_json))).toEqual({
        pivots: [{ provider: "v1" }, { provider: "v2" }, { provider: "v3" }],
      });
      // `crashService`'s own stretch is deliberately never awaited again:
      // "pinned"'s `collect()` never resolves, so its terminal write never
      // lands — this row is the crashed process's last word.

      // --- a fresh process resumes once the lease looks expired ---
      clock.now += ttl + 1;
      const freshService = new WorkflowService({
        runtime: new AlwaysCompleteRuntime(),
        auditTrail: trail,
        store: store(),
      });
      const priorView = durableFromRow(midCrashRow);
      expect(priorView.pivots).toHaveLength(3); // <-- fails on the base: null payload reads back []
      const fourthAttempt = freshService.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          routeOverride: { provider: "v4" },
        },
      );
      expect("error" in fourthAttempt).toBe(true);
      if ("error" in fourthAttempt) expect(fourthAttempt.error).toContain("3");
    } finally {
      connection.close();
    }
  });

  it("a run that never pivoted keeps writing a literal null payload at registration — byte-identical to before #446", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-route-override-no-pivot-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const audit = new AuditRepository(connection.database);
      const trail = new AuditTrail(audit);
      const ownership = { fence: 0, holder: "test", now: 1000 };
      const service = new WorkflowService({
        runtime: new AlwaysCompleteRuntime(),
        auditTrail: trail,
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const started = service.start(twoNodeSpec());
      if ("error" in started) throw new Error(started.error);
      const row = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(row.pause_payload_json).toBeNull();
    } finally {
      connection.close();
    }
  });
});

describe("route-override.ts — the module's own exports (#427)", () => {
  it("applyRouteOverride only replaces the fields the override actually names", async () => {
    const { applyRouteOverride } = await import("../src/workflow/route-override.js");
    expect(applyRouteOverride({ provider: "p", model: "m", effort: "high" }, {})).toEqual({
      provider: "p",
      model: "m",
      effort: "high",
    });
    expect(
      applyRouteOverride({ provider: "p", model: "m", effort: "high" }, { model: "m2" }),
    ).toEqual({ provider: "p", model: "m2", effort: "high" });
  });

  it("overrideNode rewrites a node that declares a route, leaves one that doesn't untouched by reference", async () => {
    const { overrideNode } = await import("../src/workflow/route-override.js");
    const { Node } = await import("../src/workflow/types.js");
    const free = new Node("free", "agent", { prompt: "x" });
    const pinned = new Node("pinned", "agent", { prompt: "y", provider: "old", tier: "small" });
    expect(overrideNode(free, { provider: "new" })).toBe(free);
    const rewritten = overrideNode(pinned, { provider: "new" });
    expect(rewritten.fields.provider).toBe("new");
    expect(rewritten.fields.tier).toBe("small");
  });

  it("overrideNode also rewrites a pipeline stage that names its OWN route, not just the node's", async () => {
    const { overrideNode } = await import("../src/workflow/route-override.js");
    const { Node } = await import("../src/workflow/types.js");
    const node = new Node("p", "pipeline", {
      items: [],
      stages: [{ prompt: "s1" }, { prompt: "s2", provider: "old-stage" }],
    });
    const rewritten = overrideNode(node, { provider: "new-stage" });
    const stages = rewritten.fields.stages as readonly Record<string, unknown>[];
    expect(stages[0]?.provider).toBeUndefined();
    expect(stages[1]?.provider).toBe("new-stage");
  });

  it("pivotResume passes a plain resume (no override) straight through", async () => {
    const { pivotResume } = await import("../src/workflow/route-override.js");
    const spec = parsed({ meta: { name: "x" }, nodes: [{ id: "a", type: "agent", prompt: "x" }] });
    const result = pivotResume(spec, {}, []);
    expect(result).toEqual({ ok: true, spec });
  });

  it("pivotResume refuses an override without a resume run id, named error", async () => {
    const { pivotResume } = await import("../src/workflow/route-override.js");
    const spec = parsed({ meta: { name: "x" }, nodes: [{ id: "a", type: "agent", prompt: "x" }] });
    const result = pivotResume(spec, { routeOverride: { provider: "p" } }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("resume run id");
  });

  it("pivotResume refuses once priorPivots already reached MAX_ROUTE_PIVOTS_PER_RUN", async () => {
    const { pivotResume, MAX_ROUTE_PIVOTS_PER_RUN } =
      await import("../src/workflow/route-override.js");
    const spec = parsed({ meta: { name: "x" }, nodes: [{ id: "a", type: "agent", prompt: "x" }] });
    const full = Array.from({ length: MAX_ROUTE_PIVOTS_PER_RUN }, () => ({ provider: "p" }));
    const result = pivotResume(
      spec,
      { resumeRunId: "run-1", routeOverride: { provider: "new" } },
      full,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MAX_ROUTE_PIVOTS_PER_RUN));
  });

  it("nextPivots appends only when an override is present; pivotsOf validates entries defensively", async () => {
    const { nextPivots, pivotsOf } = await import("../src/workflow/route-override.js");
    expect(nextPivots([{ provider: "a" }], undefined)).toEqual([{ provider: "a" }]);
    expect(nextPivots([{ provider: "a" }], { model: "b" })).toEqual([
      { provider: "a" },
      { model: "b" },
    ]);
    expect(pivotsOf({ pivots: [{ provider: "x" }, { provider: 123 }, "nope"] })).toEqual([
      { provider: "x" },
    ]);
    expect(pivotsOf({})).toEqual([]);
  });
});
