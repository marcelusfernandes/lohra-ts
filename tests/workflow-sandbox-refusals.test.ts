// Issue #246: a sandbox refusal inside a leaf used to vanish into the tool
// result string (`ERROR: ...`) that only the leaf's own model ever read —
// `faults: []`, `status: complete`, invariant 2 ("falha nunca é silenciosa")
// broken. This file pins the fix: `ChildResult.sandboxRefusals` (the leaf's
// own count, carried by the runtime's side channel — see
// `OrchestrationChildRuntime` in orchestration-runtime.ts) turns into an
// ADVISORY fault (`RunResult.sandboxFaults`, never `RunResult.faults` —
// `deriveStatus` only reads the latter, so a refusal alone never flips
// `status` away from "complete") plus a running total
// (`RunResult.sandboxRefusals`), both surfaced by `resultView`
// (service-rollup.ts) as `faults`/`sandbox_refusals`.
//
// AC3 ("sobrevive a resume OU é declarado volátil"): this PR chose SURVIVES.
// `sandbox_refusals` threads through `pause_payload_json` exactly like
// `leaf_respawns` (service.ts) — the COUNT is cumulative across stretches;
// the fault TEXT list in the live `resultView`, like the pre-existing
// `faults` field, only ever shows the CURRENT stretch's messages (the
// cross-process `faults_total`/`sandbox_refusals` on a durable, not-live
// read carries the full history instead — see the durability test below).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OrchestrationCore,
  type ChildRunner,
  type CollectResult,
} from "../src/orchestration/core.js";
import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { SqliteWorkflowCache } from "../src/workflow/sqlite-cache.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import { WorkflowService } from "../src/workflow/service.js";
import {
  WorkflowEngine,
  validateSpec,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
  type LeafToolDispatch,
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

/** One leaf per spawn, scripted collect() results, in call order. */
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

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("sandbox refusal — engine (#246 AC1/AC2)", () => {
  it("a leaf with sandbox refusals gets an advisory fault + a count, status stays complete", async () => {
    const runtime = new FakeRuntime([
      [
        {
          status: "complete",
          output: "ok",
          usage: { ...usage, reasoningTokens: 0 },
          sandboxRefusals: 3,
        },
      ],
    ]);
    const spec = parsed({
      meta: { name: "refused" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.status).toBe("complete");
    expect(result.sandboxRefusals).toBe(3);
    expect(result.sandboxFaults).toEqual(["a: sandbox refused 3 tool call(s)"]);
    // Never in the status-affecting list — deriveStatus reads only `faults`.
    expect(result.faults).toEqual([]);
  });

  it("zero refusals adds nothing new: no fault, count stays 0, status unaffected", async () => {
    const runtime = new FakeRuntime([
      [{ status: "complete", output: "ok", usage: { ...usage, reasoningTokens: 0 } }],
    ]);
    const spec = parsed({
      meta: { name: "clean" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.status).toBe("complete");
    expect(result.sandboxRefusals).toBe(0);
    expect(result.sandboxFaults).toEqual([]);
    expect(result.faults).toEqual([]);
  });
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

function spawnRequest(runId: string): ChildSpawnRequest {
  return {
    prompt: "do it",
    causalContext: Object.freeze({
      runId,
      segmentId: "seg-1",
      nodePath: Object.freeze(["a"]),
      cellId: "a:0",
      role: "leaf",
      attempt: 0,
      turn: 0,
    }),
  };
}

describe("sandbox refusal — runtime side channel (#246)", () => {
  it("OrchestrationChildRuntime counts only the calls the sandbox denied, per leaf", async () => {
    type ChildToolDispatch = (
      name: string,
      args: Readonly<Record<string, unknown>>,
    ) => Promise<string>;
    const denyThenAllow: (base: LeafToolDispatch) => LeafToolDispatch = (base) => (name, args) => {
      if (name === "denied") return "ERROR: sandbox denied";
      return base(name, args);
    };
    let dispatch: ((base: ChildToolDispatch) => ChildToolDispatch) | undefined;
    const runChild: ChildRunner = async (_subId, config) => {
      const base: ChildToolDispatch = (name) => Promise.resolve(`allowed:${name}`);
      dispatch = config.wrapDispatch;
      const wrapped = config.wrapDispatch === undefined ? base : config.wrapDispatch(base);
      await wrapped("denied", {});
      await wrapped("denied", {});
      await wrapped("read_file", {});
      return ok("done");
    };
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    runtime.installLeafSandbox({ runId: "r1", fence: 1, wrap: denyThenAllow });
    const id = runtime.spawn(spawnRequest("r1"));
    const result = await runtime.collect(id, { wait: true, timeoutSeconds: 5 });
    expect(result.sandboxRefusals).toBe(2);
    expect(dispatch).toBeDefined();
  });

  it("a leaf with zero denials reports sandboxRefusals 0", async () => {
    const allowAll: (base: LeafToolDispatch) => LeafToolDispatch = (base) => base;
    const runChild: ChildRunner = async (_subId, config) => {
      const base: ChildToolDispatch2 = (name) => Promise.resolve(`allowed:${name}`);
      const wrapped = config.wrapDispatch === undefined ? base : config.wrapDispatch(base);
      await wrapped("read_file", {});
      return ok("done");
    };
    type ChildToolDispatch2 = (
      name: string,
      args: Readonly<Record<string, unknown>>,
    ) => Promise<string>;
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    runtime.installLeafSandbox({ runId: "r2", fence: 1, wrap: allowAll });
    const id = runtime.spawn(spawnRequest("r2"));
    const result = await runtime.collect(id, { wait: true, timeoutSeconds: 5 });
    expect(result.sandboxRefusals).toBe(0);
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

/** A durable-shaped runtime: every one of node "a"'s leaves reports 2
 * sandbox refusals (checkpoint spawns no leaf of its own). "a" re-spawns on
 * the resume stretch too (no schema, so nothing makes it cache-replay) —
 * that is what makes the final total (stretch 1's 2 + stretch 2's 2 = 4)
 * prove the COUNT survived the resume, not merely that a single stretch's
 * own number reached the rollup. */
function durableRuntimeStub(): ChildRuntime {
  let seq = 0;
  return {
    spawn(): string {
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect(): ChildResult {
      return {
        status: "complete",
        output: "ok",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        sandboxRefusals: 2,
      };
    },
    steer(): void {},
    cancel(): void {},
    installLeafSandbox(): { dispose: () => void } {
      return { dispose: (): void => undefined };
    },
  };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "lohra-sandbox-refusals-"));
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
  const service = new WorkflowService({ runtime: durableRuntimeStub(), store, cacheFactory });
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

describe("sandbox refusal — survives resume (#246 AC3)", () => {
  it("the count persists in pause_payload_json across a paused stretch and a resume completes with the total", async () => {
    const { service, repository, store, cacheFactory, close } = harness();
    const started = service.start(checkpointSpec());
    if ("error" in started) throw new Error(started.error);
    const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused.status).toBe("paused");
    const line = repository.getRunState(started.run_id) as Record<string, unknown>;
    const payload = JSON.parse(String(line.pause_payload_json)) as {
      sandbox_refusals: number;
    };
    expect(payload.sandbox_refusals).toBe(2);

    // A genuinely cross-process, not-live read (fresh WorkflowService, same
    // store, no in-memory record for this run_id) goes through
    // durableFromRow/durableRollup instead of the live resultView — pins that
    // the durable rollup carries the count too, not just the in-process one.
    const coldService = new WorkflowService({ runtime: durableRuntimeStub(), store, cacheFactory });
    const dormantView = (await coldService.status(started.run_id)) as Record<string, unknown>;
    expect(dormantView.sandbox_refusals).toBe(2);

    const resumed = (await service.runAndWait(null, {}, { resumeRunId: started.run_id })) as Record<
      string,
      unknown
    >;
    expect(resumed.status).toBe("complete");
    // 2 (stretch 1, persisted at the pause) + 2 (stretch 2's own "a" leaf) —
    // the prior stretch's count survived the resume instead of resetting.
    expect(resumed.sandbox_refusals).toBe(4);
    close();
  });
});
