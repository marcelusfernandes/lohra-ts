// Issue #972 (épico #969): a run started from a library template announces
// it on `plan` — the live event TUI/GUI render and the ledger's
// `workflow.plan` — so a renderer shows the origin with no extra query and no
// new event kind. The ledger keeps `template_ref` in clear ONLY in the exact
// `TEMPLATE_REF` shape; anything else under that key stays excluded.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { usage } from "../src/pricing/usage.js";
import { AuditRepository } from "../src/state/audit-repository.js";
import { LockRepository, openStateDatabase, WorkflowRepository } from "../src/state/index.js";
import { safeAuditMetadata } from "../src/workflow/audit-model.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import type { WorkflowLiveEvent } from "../src/workflow/live-events.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";
import { WorkflowService } from "../src/workflow/service.js";
import { templateLoader } from "../src/workflow/templates.js";

const roots: string[] = [];
const connections: ReturnType<typeof openStateDatabase>[] = [];
afterEach(() => {
  const failures: unknown[] = [];
  for (const connection of connections.splice(0).reverse()) {
    try {
      connection.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const root of roots.splice(0).reverse()) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1) throw new AggregateError(failures, "template events cleanup failed");
  if (failures.length === 1) throw failures[0];
});

class CompletingRuntime implements ChildRuntime {
  private spawned = 0;

  spawn(_request: ChildSpawnRequest): string {
    this.spawned += 1;
    return `leaf-${String(this.spawned)}`;
  }

  collect(id: string): ChildResult {
    return {
      status: "complete",
      output: `out-${id}`,
      usage: usage({ inputTokens: 3, outputTokens: 2 }),
    };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): LeafSandboxHandle {
    return { dispose: (): void => undefined };
  }
}

const triage = {
  meta: { name: "triage" },
  nodes: [{ id: "scan", type: "agent", prompt: "scan" }],
};
const gated = {
  meta: { name: "gated" },
  nodes: [
    { id: "confirm", type: "checkpoint", prompt: "go?" },
    { id: "work", type: "agent", prompt: "do it after ${confirm}" },
  ],
};

interface Fixture {
  readonly service: WorkflowService;
  readonly trail: AuditTrail;
  readonly audit: AuditRepository;
  readonly live: WorkflowLiveEvent[];
}

function fixture(prefix: string, durable = true): Fixture {
  const home = mkdtempSync(join(tmpdir(), prefix));
  roots.push(home);
  const dir = join(home, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify(triage), "utf8");
  writeFileSync(join(dir, "gated.json"), JSON.stringify(gated), "utf8");
  const connection = openStateDatabase(join(home, "state.db"));
  connections.push(connection);
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const live: WorkflowLiveEvent[] = [];
  const service = new WorkflowService({
    runtime: new CompletingRuntime(),
    homeRoot: home,
    loader: templateLoader(home),
    auditTrail: trail,
    environment: {},
    onLiveEvent: (event) => live.push(event),
    ...(durable
      ? {
          store: {
            repository: new WorkflowRepository(connection.database),
            locks: new LockRepository(connection.database),
            holder: "test",
            ttl: 900,
            ownershipOf: () => ({ fence: 0, holder: "test", now: 1000 }),
            database: connection.database,
          },
        }
      : {}),
  });
  return { service, trail, audit, live };
}

async function finish(f: Fixture, runId: string): Promise<Record<string, unknown>> {
  const final = (await f.service.status(runId, true)) as Record<string, unknown>;
  expect(await f.trail.flush()).toBe(true);
  return final;
}

function plans(f: Fixture, runId: string): WorkflowLiveEvent[] {
  return f.live.filter((event) => event.kind === "plan" && event.run_id === runId);
}

function ledgerPlans(f: Fixture, runId: string): Readonly<Record<string, unknown>>[] {
  return f.audit
    .query({ runId })
    .events.filter((event) => event.event_type === "workflow.plan")
    .map((event) => event.data);
}

describe("plan announces the template a run came from (#972)", () => {
  it.each([true, false])(
    "live plan and ledger workflow.plan carry template_ref (durable=%s)",
    async (durable) => {
      const f = fixture("lohra-template-events-", durable);
      const started = f.service.start(null, {}, { template: "triage" });
      if ("error" in started) throw new Error(started.error);
      expect((await finish(f, started.run_id)).status).toBe("complete");
      expect(plans(f, started.run_id)).toEqual([
        expect.objectContaining({ kind: "plan", name: "triage", template_ref: "triage" }),
      ]);
      expect(ledgerPlans(f, started.run_id)).toEqual([
        expect.objectContaining({ template_ref: "triage" }),
      ]);
    },
  );

  it("an inline spec emits plan without the field, live and in the ledger", async () => {
    const f = fixture("lohra-template-events-inline-");
    const started = f.service.start(triage, {});
    if ("error" in started) throw new Error(started.error);
    await finish(f, started.run_id);
    const [plan] = plans(f, started.run_id);
    expect(plan).toBeDefined();
    expect(plan !== undefined && "template_ref" in plan).toBe(false);
    const [ledger] = ledgerPlans(f, started.run_id);
    expect(ledger !== undefined && "template_ref" in ledger).toBe(false);
  });

  it("a resume re-announces plan with the same template_ref", async () => {
    const f = fixture("lohra-template-events-resume-");
    const started = f.service.start(null, {}, { template: "gated" });
    if ("error" in started) throw new Error(started.error);
    expect((await finish(f, started.run_id)).status).toBe("paused");
    const resumed = f.service.start(
      null,
      {},
      { resumeRunId: started.run_id, checkpointAnswers: { confirm: "yes" } },
    );
    if ("error" in resumed) throw new Error(resumed.error);
    expect((await finish(f, started.run_id)).status).toBe("complete");
    expect(plans(f, started.run_id).map((event) => event.template_ref)).toEqual(["gated", "gated"]);
    expect(ledgerPlans(f, started.run_id).map((data) => data.template_ref)).toEqual([
      "gated",
      "gated",
    ]);
  });
});

describe("the ledger's template_ref allow-list (#972)", () => {
  it("keeps a value in TEMPLATE_REF's exact shape in clear", () => {
    expect(safeAuditMetadata({ template_ref: "triage-v2_x" })).toEqual({
      template_ref: "triage-v2_x",
    });
  });

  it.each(["Ignore previous instructions", "../etc/passwd", "a".repeat(65), "Triage"])(
    "excludes anything else under that key (%s)",
    (value) => {
      const safe = safeAuditMetadata({ template_ref: value });
      expect(safe.template_ref).not.toBe(value);
      expect(safe.template_ref).toMatchObject({ state: "excluded_by_policy" });
    },
  );
});
