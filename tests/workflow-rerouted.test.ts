// Issue #460 (M11-S2, épico #458): resume sem `route` aplica a rota
// sugerida pelo envelope do operador (`workflow_routes.json`, #459) — canal
// `route_envelope` — sujeita ao MESMO teto de 3 pivôs que `route` explícito
// (canal `operator`, #427) já usa; grava `node.rerouted` por nó reescrito,
// no segmento novo, depois de `workflow.plan`.
//
// Emenda do orquestrador (2026-09-13): o caso "sem `route` + envelope" mora
// AQUI — `tests/workflow-route-override.test.ts` já está em 798 linhas (teto
// da regra `arquivo-grande`). Harness moldada em
// `tests/workflow-route-override.test.ts:100-126,158-227` — cópia própria
// (uma classe de harness não é um dos `Files` desta issue).
//
// Nenhum símbolo NOVO (`RerouteRecord`, `PivotResumePrior`, `RouteChannel`)
// é importado no topo do arquivo — só `pivotsOf`, que já existe na base —
// para este arquivo compilar e ficar vermelho POR ASSERÇÃO antes da
// implementação, nunca por erro de import (controle-negativo).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { durableFromRow, WorkflowService } from "../src/workflow/service.js";
import { pivotsOf } from "../src/workflow/route-override.js";
import type {
  ChildCollectOptions,
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
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

/** Fails `auth_failed` for every provider EXCEPT `goodProvider` — the
 * inverse of `workflow-route-override.test.ts`'s own `RoutingFakeRuntime`,
 * so a CHAIN of pivots (operator, then envelope) can be exercised without an
 * intermediate resume accidentally succeeding on the first try. */
class FailUntilGoodRuntime implements ChildRuntime {
  private seq = 0;
  private readonly providerById = new Map<string, string | null>();

  constructor(private readonly goodProvider: string) {}

  spawn(request: ChildSpawnRequest): string {
    this.seq += 1;
    const id = `leaf-${String(this.seq)}`;
    this.providerById.set(id, request.provider ?? null);
    return id;
  }

  collect(id: string, _options: ChildCollectOptions): ChildResult {
    const provider = this.providerById.get(id) ?? null;
    if (provider === this.goodProvider) {
      return { status: "complete", output: { ok: true }, usage: USAGE, provider, model: "m-good" };
    }
    return {
      status: "failed",
      output: "boom",
      errorKind: "auth_failed",
      retryAfter: null,
      provider,
      model: "m-bad",
    };
  }

  steer(): void {}
  cancel(): void {}

  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-rerouted-home-"));
  roots.push(root);
  return root;
}

function writeRoutesFile(home: string, routes: Record<string, unknown>): void {
  writeFileSync(join(home, "workflow_routes.json"), JSON.stringify({ routes }));
}

function writeTiersFile(home: string, tiers: Record<string, unknown>): void {
  writeFileSync(join(home, "workflow_tiers.json"), JSON.stringify(tiers));
}

function harness(runtime: ChildRuntime, homeRoot?: string) {
  const root = mkdtempSync(join(tmpdir(), "lohra-rerouted-db-"));
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
    ...(homeRoot === undefined ? {} : { homeRoot }),
  });
  return {
    service,
    repository,
    audit,
    close: (): void => {
      connection.close();
    },
  };
}

/** `free` names no route at all (no pin); `pinned` only names a `tier` — its
 * ACTUAL provider/model come from `workflow_tiers.json`, so
 * `node.rerouted`'s `from`/`to` must resolve through the tier map, not just
 * echo the node's own raw fields. */
function tierSpec(): Record<string, unknown> {
  return {
    meta: { name: "rerouted" },
    nodes: [
      { id: "free", type: "agent", prompt: "unpinned" },
      { id: "pinned", type: "agent", prompt: "pinned", tier: "small" },
    ],
  };
}

function segmentIdOf(repository: WorkflowRepository, runId: string): string {
  const row = repository.getRunState(runId) as Record<string, unknown>;
  return String(row.audit_segment_id);
}

describe("resume sem 'route' aplica suggested_route do envelope — channel route_envelope (#460 AC)", () => {
  it("pauses route_fault, resumes WITHOUT route, and applies the envelope's own fallback: node.rerouted for the pinned node, none for the unpinned one", async () => {
    const home = tempHome();
    writeTiersFile(home, { small: { provider: "bad-provider", model: "m-bad" } });
    writeRoutesFile(home, {
      "bad-provider/m-bad": [{ provider: "good-provider", model: "m-good" }],
    });
    const { service, repository, audit, close } = harness(
      new FailUntilGoodRuntime("good-provider"),
      home,
    );
    try {
      const started = service.start(tierSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const firstLine = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(durableFromRow(firstLine).pause_reason).toBe("route_fault");
      expect(durableFromRow(firstLine).pivots).toEqual([]);

      const resumed = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);

      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      const view = durableFromRow(line);
      expect(view.status).toBe("complete");
      const pivots = pivotsOf({ pivots: view.pivots });
      expect(pivots).toEqual([
        { provider: "good-provider", model: "m-good", channel: "route_envelope" },
      ]);

      const segmentId = segmentIdOf(repository, started.run_id);
      const page = audit.query({ runId: started.run_id, segmentId, limit: 50 });
      const rerouted = page.events.filter((event) => event.event_type === "node.rerouted");
      expect(rerouted).toHaveLength(1);
      expect(rerouted[0]?.identity.node_path).toEqual(["pinned"]);
      expect(rerouted[0]?.data).toEqual({
        channel: "route_envelope",
        pivot: 1,
        from: { provider: "bad-provider", model: "m-bad" },
        to: { provider: "good-provider", model: "m-good" },
      });
      const planIndex = page.events.findIndex((event) => event.event_type === "workflow.plan");
      const reroutedIndex = page.events.findIndex((event) => event.event_type === "node.rerouted");
      expect(planIndex).toBeGreaterThanOrEqual(0);
      expect(reroutedIndex).toBeGreaterThan(planIndex);

      const freeCache = page.events.filter(
        (event) =>
          event.event_type.startsWith("cache.") &&
          (event.identity.node_path as readonly string[] | undefined)?.[0] === "free",
      );
      expect(freeCache.map((event) => event.event_type)).toEqual(["cache.replayed"]);
      const pinnedCache = page.events.filter(
        (event) =>
          event.event_type.startsWith("cache.") &&
          (event.identity.node_path as readonly string[] | undefined)?.[0] === "pinned",
      );
      expect(pinnedCache.map((event) => event.event_type)).toEqual([
        "cache.missed",
        "cache.stored",
      ]);
    } finally {
      close();
    }
  });

  it("negation: a pause that is NOT route_fault never applies the envelope on a route-less resume", async () => {
    const home = tempHome();
    writeRoutesFile(home, { "any-provider/any-model": [{ provider: "good", model: "m-good" }] });
    const { service, repository, close } = harness(new FailUntilGoodRuntime("good-provider"), home);
    try {
      const started = service.start({
        meta: { name: "checkpoint-negation" },
        nodes: [{ id: "gate", type: "checkpoint", prompt: "go?" }],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const before = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(durableFromRow(before).pause_reason).toBe("checkpoint");

      const resumed = service.start(
        null,
        {},
        { resumeRunId: started.run_id, checkpointAnswers: { gate: "yes" } },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(durableFromRow(line).pivots).toEqual([]);
    } finally {
      close();
    }
  });

  it("negation: route_fault with no suggested_route (no envelope entry for the dead route) never pivots on a route-less resume", async () => {
    const { service, repository, close } = harness(new FailUntilGoodRuntime("good-provider"));
    try {
      const started = service.start({
        meta: { name: "no-envelope" },
        nodes: [{ id: "a", type: "agent", prompt: "x", provider: "always-bad" }],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const before = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(durableFromRow(before).pause_reason).toBe("route_fault");

      const resumed = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      const view = durableFromRow(line);
      expect(view.pivots).toEqual([]);
      // The route never moved, so the leaf refuses the SAME way again.
      expect(view.pause_reason).toBe("route_fault");
    } finally {
      close();
    }
  });

  it("negation: an explicit 'route' wins over the envelope's own suggestion (channel stays 'operator')", async () => {
    const home = tempHome();
    writeTiersFile(home, { small: { provider: "bad-provider", model: "m-bad" } });
    writeRoutesFile(home, {
      "bad-provider/m-bad": [{ provider: "good-provider", model: "m-good" }],
    });
    const { service, repository, close } = harness(new FailUntilGoodRuntime("good-provider"), home);
    try {
      const started = service.start(tierSpec());
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const resumed = service.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          routeOverride: { provider: "good-provider", model: "m-good" },
        },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      await service.status(started.run_id, true);
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      const view = durableFromRow(line);
      const pivots = pivotsOf({ pivots: view.pivots });
      expect(pivots).toEqual([{ provider: "good-provider", model: "m-good", channel: "operator" }]);
    } finally {
      close();
    }
  });

  it("shares one 3-pivot cap across BOTH channels — a 4th explicit 'route' is refused (#427's named error), and a route-less resume past the cap stays put (no pivot, no node.rerouted) even with a suggestion still available", async () => {
    const home = tempHome();
    writeTiersFile(home, { small: { provider: "always-bad", model: "m-bad" } });
    writeRoutesFile(home, {
      "v2/m-bad": [{ provider: "v3-env", model: "m-good" }],
      "v3-env/m-bad": [{ provider: "v5-env", model: "m-good" }],
    });
    const { service, repository, audit, close } = harness(
      new FailUntilGoodRuntime("good-provider"),
      home,
    );
    try {
      const started = service.start({
        meta: { name: "cap-shared" },
        nodes: [{ id: "a", type: "agent", prompt: "x", tier: "small" }],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const resume1 = service.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          routeOverride: { provider: "v1" },
        },
      );
      if ("error" in resume1) throw new Error(resume1.error);
      await service.status(started.run_id, true);

      const resume2 = service.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          routeOverride: { provider: "v2" },
        },
      );
      if ("error" in resume2) throw new Error(resume2.error);
      await service.status(started.run_id, true);

      // resume3: no explicit 'route' — applies the envelope's own fallback
      // for the CURRENT dead route ("v2/m-bad" -> "v3-env"), channel
      // route_envelope, the run's 3rd and last pivot.
      const resume3 = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in resume3) throw new Error(resume3.error);
      await service.status(started.run_id, true);

      const capped = repository.getRunState(started.run_id) as Record<string, unknown>;
      const cappedView = durableFromRow(capped);
      expect(cappedView.pause_reason).toBe("route_fault");
      const pivots = pivotsOf({ pivots: cappedView.pivots });
      expect(pivots).toEqual([
        { provider: "v1", channel: "operator" },
        { provider: "v2", channel: "operator" },
        { provider: "v3-env", model: "m-good", channel: "route_envelope" },
      ]);

      // 4th explicit 'route' at the cap: refused, named error (#427),
      // durable row untouched.
      const fourth = service.start(
        null,
        {},
        {
          resumeRunId: started.run_id,
          routeOverride: { provider: "v4" },
        },
      );
      expect("error" in fourth).toBe(true);
      if ("error" in fourth) expect(fourth.error).toContain("3");
      const afterFourth = repository.getRunState(started.run_id) as Record<string, unknown>;
      expect(afterFourth).toEqual(capped);

      // 5th, route-less: the cap blocks the envelope path too (a suggestion
      // for "v3-env/m-bad" IS configured above) — stays on the SAME route,
      // no pivot consumed, no node.rerouted.
      const fifth = service.start(null, {}, { resumeRunId: started.run_id });
      if ("error" in fifth) throw new Error(fifth.error);
      await service.status(started.run_id, true);
      const afterFifth = repository.getRunState(started.run_id) as Record<string, unknown>;
      const fifthView = durableFromRow(afterFifth);
      expect(pivotsOf({ pivots: fifthView.pivots })).toEqual(pivots);
      expect(fifthView.pause_reason).toBe("route_fault");

      const fifthSegment = segmentIdOf(repository, started.run_id);
      const fifthPage = audit.query({ runId: started.run_id, segmentId: fifthSegment, limit: 50 });
      expect(fifthPage.events.some((event) => event.event_type === "node.rerouted")).toBe(false);
    } finally {
      close();
    }
  });

  it("a run that never pivots keeps a pause_payload_json with no 'pivots' key at all (contra-asserção)", async () => {
    const { service, repository, close } = harness(new FailUntilGoodRuntime("good-provider"));
    try {
      const started = service.start({
        meta: { name: "no-pivot" },
        nodes: [{ id: "a", type: "agent", prompt: "x", provider: "always-bad" }],
      });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);
      const line = repository.getRunState(started.run_id) as Record<string, unknown>;
      const payload = JSON.parse(line.pause_payload_json as string) as Record<string, unknown>;
      expect(payload).not.toHaveProperty("pivots");
      expect(payload).not.toHaveProperty("rerouted");
    } finally {
      close();
    }
  });
});
