// Issue #399 (M8-2, épico #396): `errorKind` (M8-1, #397) já carrega o
// vocabulário fechado `ErrorKind`, mas nenhum campo estruturado leva o KIND
// para fora do texto da mensagem. Este arquivo pina `RunResult.faultKinds`
// (accounting.ts), `fault_kinds` no rollup vivo (service-rollup.ts),
// `prior_fault_kinds`/`fault_kinds_total` no durável (service.ts) — sempre
// ADITIVO: `faults`/mensagens continuam byte-idênticos (os quatro arquivos
// de pino da issue #399 — `tests/workflow-sandbox-refusals.test.ts`,
// `workflow-parallel-retries.test.ts`, `workflow-executor.test.ts`,
// `workflow-service-durability.test.ts` — não precisaram de ajuste: nenhum
// `toEqual` de forma quebrou; só o stub de `workflow-service-durability.test.ts`
// teve o TIPO do parâmetro `errorKind` estreitado, sem teste novo lá — a
// issue #399 restringe todo teste NOVO a este arquivo).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { SqliteWorkflowCache } from "../src/workflow/sqlite-cache.js";
import { durableFromRow, durableRollup, WorkflowService } from "../src/workflow/service.js";
import {
  WorkflowEngine,
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

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** One leaf per spawn, scripted collect() results, in call order — same
 * molde as `tests/workflow-sandbox-refusals.test.ts`'s `FakeRuntime`. */
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

  collect(id: string, _options: ChildCollectOptions): ChildResult {
    const script = this.byId.get(id) ?? [];
    return script.shift() ?? { status: "failed", output: "script exhausted" };
  }

  steer(): void {}
  cancel(): void {}

  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

describe("fault_kinds — engine (#399 AC1/AC2)", () => {
  it("a leaf that fails with auth_failed populates faultKinds; faults/status unchanged", async () => {
    const runtime = new FakeRuntime([
      [{ status: "failed", output: "401", errorKind: "auth_failed", retryAfter: null }],
    ]);
    const spec = parsed({
      meta: { name: "auth-fails" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.faultKinds).toEqual(["auth_failed"]);
    // The single node's failure zeroes its own output — deriveStatus reads
    // `nullCount >= nodesTotal` before `faults.length > 0` (accounting.ts).
    expect(result.status).toBe("failed");
    expect(result.faults).toEqual(["a: leaf failed (auth_failed): 401"]);
  });

  it("a leaf that completes cleanly never adds a fault kind", async () => {
    const runtime = new FakeRuntime([
      [{ status: "complete", output: "ok", usage: { ...usage, reasoningTokens: 0 } }],
    ]);
    const spec = parsed({
      meta: { name: "clean" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.faultKinds).toEqual([]);
  });
});

describe("fault_kinds — quota guard never enters (issue #412, engine-utils.ts:490)", () => {
  it("a leaf that fails with quota_exhausted never enters faultKinds; the run pauses by quota", async () => {
    const runtime = new FakeRuntime([
      [{ status: "failed", output: "429", errorKind: "quota_exhausted", retryAfter: null }],
    ]);
    const spec = parsed({
      meta: { name: "quota-only" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 0 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.faultKinds).toEqual([]);
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("quota_exhausted");
  });

  it("a quota leaf alongside an auth_failed leaf keeps only auth_failed in faultKinds", async () => {
    const runtime = new FakeRuntime([
      [{ status: "failed", output: "401", errorKind: "auth_failed", retryAfter: null }],
      [{ status: "failed", output: "429", errorKind: "quota_exhausted", retryAfter: null }],
    ]);
    const spec = parsed({
      meta: { name: "quota-and-auth" },
      nodes: [
        { id: "a", type: "agent", prompt: "x", retries: 0 },
        { id: "b", type: "agent", prompt: "y", retries: 0 },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.faultKinds).toEqual(["auth_failed"]);
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("quota_exhausted");
  });
});

describe("fault_kinds — nested workflow folds into the parent (#399 AC4)", () => {
  it("a sub-workflow leaf failing with auth_failed folds its kind into the parent's RunResult", async () => {
    const runtime = new FakeRuntime([
      [{ status: "failed", output: "401", errorKind: "auth_failed", retryAfter: null }],
    ]);
    const engine = new WorkflowEngine({
      runtime,
      loader: () => ({
        meta: { name: "child" },
        nodes: [{ id: "leaf", type: "agent", prompt: "x" }],
      }),
    });
    const spec = parsed({
      meta: { name: "outer-auth-fail" },
      nodes: [{ id: "sub", type: "workflow", ref: "child" }],
    });
    const result = await engine.run(spec);
    expect(result.faultKinds).toEqual(["auth_failed"]);
  });
});

describe("fault_kinds — WorkflowService rollup (#399 AC2)", () => {
  it("workflow_status carries fault_kinds for a real caller", async () => {
    const runtime = new FakeRuntime([
      [{ status: "failed", output: "401", errorKind: "auth_failed", retryAfter: null }],
    ]);
    const service = new WorkflowService({ runtime });
    const started = service.start({
      meta: { name: "status-fault-kind" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    if ("error" in started) throw new Error(started.error);
    const view = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(view.fault_kinds).toEqual(["auth_failed"]);
  });
});

describe("fault_kinds — durable compatibility (#399 AC3)", () => {
  it("a row whose pause_payload_json has no prior_fault_kinds defaults to [] instead of throwing", () => {
    const view = durableFromRow({
      run_id: "old-row",
      name: "old",
      status: "paused",
      pause_reason: "checkpoint",
      pause_payload_json: JSON.stringify({
        checkpoint: {},
        attempts: 1,
        prior_faults: ["a: leaf failed: boom"],
        prior_degraded: true,
      }),
      updated_at: 0,
    });
    expect(view.prior_fault_kinds).toEqual([]);
  });

  it("a pause_payload_json line adulterated with a non-vocabulary fault kind is filtered from fault_kinds_total", () => {
    const view = durableFromRow({
      run_id: "adulterated-row",
      name: "adulterated",
      status: "paused",
      pause_reason: "checkpoint",
      pause_payload_json: JSON.stringify({
        checkpoint: {},
        attempts: 1,
        prior_faults: ["a: leaf failed: boom", "b: leaf failed: boom"],
        prior_fault_kinds: ["auth_failed", "garbage"],
        prior_degraded: true,
      }),
      updated_at: 0,
    });
    const rollup = durableRollup(view, 0, false);
    expect(rollup.fault_kinds_total).toEqual(["auth_failed"]);
  });
});

function checkpointSpec(): Record<string, unknown> {
  return {
    meta: { name: "cp" },
    nodes: [
      { id: "a", type: "agent", prompt: "x" },
      { id: "cp1", type: "checkpoint", prompt: "answer?", default: "yes" },
    ],
  };
}

/** Every leaf of node "a" fails with `auth_failed` — one on each stretch,
 * mirroring `tests/workflow-sandbox-refusals.test.ts`'s `durableRuntimeStub`
 * (the checkpoint pauses stretch 1; "a" re-spawns on the resume stretch,
 * proving accumulation survives the resume, not just one stretch's own
 * number). */
function durableAuthFailRuntimeStub(): ChildRuntime {
  let seq = 0;
  return {
    spawn(): string {
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect(): ChildResult {
      return { status: "failed", output: "401", errorKind: "auth_failed", retryAfter: null };
    },
    steer(): void {},
    cancel(): void {},
    installLeafSandbox(): { dispose: () => void } {
      return { dispose: (): void => undefined };
    },
  };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "lohra-fault-kinds-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const ownership = { fence: 0 as number, holder: "test", now: 1000 };
  const store = {
    repository,
    locks,
    holder: "test",
    ttl: 900,
    ownershipOf: () => ownership,
    database: connection.database,
  };
  const cacheFactory = (runId: string): SqliteWorkflowCache =>
    new SqliteWorkflowCache(connection.database, runId, () => ({
      fence: ownership.fence,
      holder: ownership.holder,
      now: ownership.now,
    }));
  const service = new WorkflowService({
    runtime: durableAuthFailRuntimeStub(),
    store,
    cacheFactory,
  });
  return {
    service,
    repository,
    store,
    cacheFactory,
    close: () => {
      connection.close();
    },
  };
}

describe("fault_kinds — survives resume, cross-process (#399 AC3)", () => {
  it("prior_fault_kinds persists in pause_payload_json, a cold read exposes fault_kinds_total, and resume accumulates", async () => {
    const { service, repository, store, cacheFactory, close } = harness();
    const started = service.start(checkpointSpec());
    if ("error" in started) throw new Error(started.error);
    const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused.status).toBe("paused");
    expect(paused.fault_kinds).toEqual(["auth_failed"]);

    const line = repository.getRunState(started.run_id) as Record<string, unknown>;
    const payload = JSON.parse(String(line.pause_payload_json)) as {
      prior_fault_kinds: string[];
    };
    expect(payload.prior_fault_kinds).toEqual(["auth_failed"]);

    const coldService = new WorkflowService({
      runtime: durableAuthFailRuntimeStub(),
      store,
      cacheFactory,
    });
    const dormantView = (await coldService.status(started.run_id)) as Record<string, unknown>;
    expect(dormantView.fault_kinds_total).toEqual(["auth_failed"]);

    const resumed = (await service.runAndWait(null, {}, { resumeRunId: started.run_id })) as Record<
      string,
      unknown
    >;
    // "cp1" resolves this stretch, but "a" fails again — degraded, not
    // complete (both nodes reached a terminal state, deriveStatus reads
    // `faults.length > 0` since `nullCount < nodesTotal` this time).
    expect(resumed.status).toBe("degraded");
    // The live view is current-stretch-only, same pre-existing shape as
    // `faults` always had (service.ts never folds `prior_faults` into it
    // either) — stretch 2's OWN leaf failure, not stretch 1's too.
    expect(resumed.fault_kinds).toEqual(["auth_failed"]);

    // The DURABLE total is what actually accumulates across stretches —
    // order of occurrence, no dedupe (issue #399's explicit rollup
    // contract): stretch 1's carried-forward kind + stretch 2's own.
    const afterResume = new WorkflowService({
      runtime: durableAuthFailRuntimeStub(),
      store,
      cacheFactory,
    });
    const finalView = (await afterResume.status(started.run_id)) as Record<string, unknown>;
    expect(finalView.fault_kinds_total).toEqual(["auth_failed", "auth_failed"]);
    close();
  });
});
