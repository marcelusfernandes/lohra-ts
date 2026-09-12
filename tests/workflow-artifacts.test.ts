// Issue #463 (M11-S5, épico #458, decision 6): a `write_file` a leaf's own
// tool call actually wrote used to only exist on disk — the run's manifest
// was the operator's `ls`, never something `workflow_status` could answer.
// This file pins the fix: the sandbox's side channel (molded on the
// refusal counter, #246 — see `tests/workflow-sandbox-refusals.test.ts`)
// records every `write_file` an `ok: true` envelope for, `RunResult`
// accumulates it as `artifacts`/`artifactFaults`, and the public rollup
// (`resultView`/`durableRollup`, service-rollup.ts/service.ts) exposes it —
// a path two sibling leaves both wrote is an ADVISORY fault (doctrine #248,
// `docs/decisions/2026-09-10-fanout-fs-compartilhado.md`), never a `status`
// flip.
//
// Every assertion below reads a field the BASE (pre-#463) either omits
// entirely or never populates — no new symbol is imported at the top of
// this file; the runtime under test is exercised exactly like
// `tests/workflow-sandbox-refusals.test.ts` already does for
// `sandboxRefusals`, so a failure here is a real assertion (a value the
// base never produces), never a collection/import error.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OrchestrationCore,
  type ChildRunner,
  type ChildToolDispatch,
  type CollectResult,
} from "../src/orchestration/core.js";
import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { SqliteWorkflowCache } from "../src/workflow/sqlite-cache.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import { WorkflowService } from "../src/workflow/service.js";
import { toolError as envelopeToolError, toolResult } from "../src/tools/envelope.js";
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

/** One leaf per spawn, scripted collect() results, in call order — the
 * SAME `FakeRuntime` shape `tests/workflow-sandbox-refusals.test.ts` uses. */
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

function spawnRequest(runId: string) {
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

describe("write-file manifest — runtime side channel (#463)", () => {
  it("records only ok:true write_file calls, never a refusal, an ok:false write, or another tool", async () => {
    const denyThenAllow: (base: LeafToolDispatch) => LeafToolDispatch = (base) => (name, args) => {
      if (name === "denied") return "ERROR: sandbox denied";
      return base(name, args);
    };
    const runChild: ChildRunner = async (subId, config) => {
      const base: ChildToolDispatch = (name, args) => {
        if (name === "write_file") {
          const path = String(args.path);
          if (path === "/fails.txt") return Promise.resolve(envelopeToolError("disk full"));
          return Promise.resolve(
            toolResult(undefined, { bytes_written: Number(args.bytes), path }),
          );
        }
        return Promise.resolve(`allowed:${name}`);
      };
      const wrapped = config.wrapDispatch === undefined ? base : config.wrapDispatch(base, subId);
      await wrapped("denied", {});
      await wrapped("write_file", { path: "/ok-1.txt", bytes: 5 });
      await wrapped("write_file", { path: "/fails.txt", bytes: 9 });
      await wrapped("read_file", { path: "/ok-1.txt" });
      await wrapped("write_file", { path: "/ok-2.txt", bytes: 7 });
      return ok("done");
    };
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    runtime.installLeafSandbox({ runId: "r-art-1", fence: 1, wrap: denyThenAllow });
    const id = runtime.spawn(spawnRequest("r-art-1"));
    const result = await runtime.collect(id, { wait: true, timeoutSeconds: 5 });
    expect(result.artifacts).toEqual([
      { path: "/ok-1.txt", bytes: 5 },
      { path: "/ok-2.txt", bytes: 7 },
    ]);
    expect(result.artifactsDropped).toBeUndefined();
  });

  it("a leaf that writes nothing reports artifacts absent, not an empty array", async () => {
    const allowAll: (base: LeafToolDispatch) => LeafToolDispatch = (base) => base;
    const runChild: ChildRunner = async (subId, config) => {
      const base: ChildToolDispatch = (name) => Promise.resolve(`allowed:${name}`);
      const wrapped = config.wrapDispatch === undefined ? base : config.wrapDispatch(base, subId);
      await wrapped("read_file", {});
      return ok("done");
    };
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    runtime.installLeafSandbox({ runId: "r-art-2", fence: 1, wrap: allowAll });
    const id = runtime.spawn(spawnRequest("r-art-2"));
    const result = await runtime.collect(id, { wait: true, timeoutSeconds: 5 });
    expect(result.artifacts).toBeUndefined();
    expect(result.artifactsDropped).toBeUndefined();
  });

  it("the per-leaf cap drops write_file records past the limit, counted, never silent", async () => {
    // MAX_ARTIFACTS_PER_LEAF (orchestration-runtime.ts) is 256 — hardcoded
    // here (never imported) so this file's only top-level imports are
    // symbols the BASE already has; a cap change updates this literal too.
    const totalWrites = 257;
    const allowAll: (base: LeafToolDispatch) => LeafToolDispatch = (base) => base;
    const runChild: ChildRunner = async (subId, config) => {
      const base: ChildToolDispatch = (name, args) =>
        name === "write_file"
          ? Promise.resolve(toolResult(undefined, { bytes_written: 1, path: String(args.path) }))
          : Promise.resolve(`allowed:${name}`);
      const wrapped = config.wrapDispatch === undefined ? base : config.wrapDispatch(base, subId);
      for (let i = 0; i < totalWrites; i += 1) {
        await wrapped("write_file", { path: `/cap-${String(i)}.txt` });
      }
      return ok("done");
    };
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    runtime.installLeafSandbox({ runId: "r-art-3", fence: 1, wrap: allowAll });
    const id = runtime.spawn(spawnRequest("r-art-3"));
    const result = await runtime.collect(id, { wait: true, timeoutSeconds: 5 });
    expect(result.artifacts).toHaveLength(256);
    expect(result.artifactsDropped).toBe(1);
  });
});

describe("write-file manifest — engine accounting (#463)", () => {
  it("two parallel leaves writing different paths both land in RunResult.artifacts, no fault", async () => {
    const runtime = new FakeRuntime([
      [
        {
          status: "complete",
          output: "a",
          usage: { ...usage, reasoningTokens: 0 },
          artifacts: [{ path: "/a.txt", bytes: 3 }],
        },
      ],
      [
        {
          status: "complete",
          output: "b",
          usage: { ...usage, reasoningTokens: 0 },
          artifacts: [{ path: "/b.txt", bytes: 4 }],
        },
      ],
    ]);
    const spec = parsed({
      meta: { name: "fanout" },
      nodes: [
        {
          id: "p",
          type: "parallel",
          branches: ["x", "y"],
        },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.status).toBe("complete");
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every((entry) => entry.node_id === "p")).toBe(true);
    expect(new Set(result.artifacts.map((entry) => entry.sub_id)).size).toBe(2);
    expect(result.artifacts.map((entry) => entry.path).sort()).toEqual(["/a.txt", "/b.txt"]);
    expect(result.artifactFaults).toEqual([]);
  });

  it("two parallel leaves writing the SAME path both stay in artifacts, one advisory fault, status unaffected", async () => {
    const runtime = new FakeRuntime([
      [
        {
          status: "complete",
          output: "a",
          usage: { ...usage, reasoningTokens: 0 },
          artifacts: [{ path: "/shared.txt", bytes: 3 }],
        },
      ],
      [
        {
          status: "complete",
          output: "b",
          usage: { ...usage, reasoningTokens: 0 },
          artifacts: [{ path: "/shared.txt", bytes: 9 }],
        },
      ],
    ]);
    const spec = parsed({
      meta: { name: "collide" },
      nodes: [
        {
          id: "p",
          type: "parallel",
          branches: ["x", "y"],
        },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.status).toBe("complete");
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every((entry) => entry.path === "/shared.txt")).toBe(true);
    expect(result.artifactFaults).toEqual(["p: artifact path written by 2 leaves: /shared.txt"]);
    // Advisory only — never in the status-affecting list (decision 6, #458).
    expect(result.faults).toEqual([]);
  });

  it("a leaf that never wrote adds nothing: artifacts stays empty, no fault", async () => {
    const runtime = new FakeRuntime([
      [{ status: "complete", output: "ok", usage: { ...usage, reasoningTokens: 0 } }],
    ]);
    const spec = parsed({
      meta: { name: "clean" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.artifacts).toEqual([]);
    expect(result.artifactFaults).toEqual([]);
  });
});

describe("write-file manifest — nested workflow folds into the parent (#463)", () => {
  it("a nested type:workflow leaf's artifact folds into the parent's RunResult with a scoped node_id", async () => {
    const runtime = new FakeRuntime([
      [
        {
          status: "complete",
          output: "inner",
          usage: { ...usage, reasoningTokens: 0 },
          artifacts: [{ path: "/nested.txt", bytes: 6 }],
        },
      ],
    ]);
    const engine = new WorkflowEngine({
      runtime,
      loader: () => ({
        meta: { name: "child" },
        nodes: [{ id: "leaf", type: "agent", prompt: "x" }],
      }),
    });
    const spec = parsed({
      meta: { name: "outer-artifact" },
      nodes: [{ id: "sub", type: "workflow", ref: "child" }],
    });
    const result = await engine.run(spec);
    expect(result.status).toBe("complete");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      node_id: "sub[child]:leaf",
      path: "/nested.txt",
      bytes: 6,
    });
    expect(typeof result.artifacts[0]?.sub_id).toBe("string");
  });
});

describe("write-file manifest — reaches the public rollup (#463)", () => {
  it("WorkflowService.status surfaces artifacts and folds artifactFaults into faults", async () => {
    const runtime = new FakeRuntime([
      [
        {
          status: "complete",
          output: "a",
          usage: { ...usage, reasoningTokens: 0 },
          artifacts: [{ path: "/x.txt", bytes: 2 }],
        },
      ],
      [
        {
          status: "complete",
          output: "b",
          usage: { ...usage, reasoningTokens: 0 },
          artifacts: [{ path: "/x.txt", bytes: 5 }],
        },
      ],
    ]);
    const service = new WorkflowService({ runtime });
    const started = service.start({
      meta: { name: "rollup" },
      nodes: [
        {
          id: "p",
          type: "parallel",
          branches: ["x", "y"],
        },
      ],
    });
    if ("error" in started) throw new Error(started.error);
    const view = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(view.status).toBe("complete");
    expect(view.artifacts as unknown[]).toHaveLength(2);
    expect(view.faults as unknown[]).toContain("p: artifact path written by 2 leaves: /x.txt");
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

/** A durable-shaped runtime: every leaf writes the SAME `path` — molded on
 * `durableRuntimeStub` (tests/workflow-sandbox-refusals.test.ts). */
function artifactRuntimeStub(path: string): ChildRuntime {
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
        artifacts: [{ path, bytes: 3 }],
      };
    },
    steer(): void {},
    cancel(): void {},
    installLeafSandbox(): { dispose: () => void } {
      return { dispose: (): void => undefined };
    },
  };
}

/** A durable-shaped runtime whose leaf never writes anything. */
function cleanRuntimeStub(): ChildRuntime {
  return {
    spawn(): string {
      return "leaf-1";
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
      };
    },
    steer(): void {},
    cancel(): void {},
    installLeafSandbox(): { dispose: () => void } {
      return { dispose: (): void => undefined };
    },
  };
}

function harness(runtime: ChildRuntime) {
  const root = mkdtempSync(join(tmpdir(), "lohra-artifacts-"));
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
  const service = new WorkflowService({ runtime, store, cacheFactory });
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

describe("write-file manifest — durable: survives resume (#463)", () => {
  it("accumulates across stretches: live paused view, pause_payload_json, resumed terminal view, and the cold rollup", async () => {
    const { service, repository, store, cacheFactory, close } = harness(
      artifactRuntimeStub("/s1.txt"),
    );
    const started = service.start(checkpointSpec());
    if ("error" in started) throw new Error(started.error);
    const paused = (await service.status(started.run_id, true)) as Record<string, unknown>;
    expect(paused.status).toBe("paused");
    expect((paused.artifacts as { path: string }[]).map((entry) => entry.path)).toEqual([
      "/s1.txt",
    ]);

    const line = repository.getRunState(started.run_id) as Record<string, unknown>;
    const payload = JSON.parse(String(line.pause_payload_json)) as { artifacts?: unknown[] };
    expect(payload.artifacts).toHaveLength(1);

    const resumeService = new WorkflowService({
      runtime: artifactRuntimeStub("/s2.txt"),
      store,
      cacheFactory,
    });
    const resumed = (await resumeService.runAndWait(
      null,
      {},
      { resumeRunId: started.run_id, checkpointAnswers: { cp1: "yes" } },
    )) as Record<string, unknown>;
    expect(resumed.status).toBe("complete");
    expect((resumed.artifacts as { path: string }[]).map((entry) => entry.path)).toEqual([
      "/s1.txt",
      "/s2.txt",
    ]);

    // A genuinely cross-process, not-live read — durableFromRow/durableRollup,
    // never the in-process resultView (molde #246 AC3's own cold-service check).
    const coldService = new WorkflowService({
      runtime: artifactRuntimeStub("/unused.txt"),
      store,
      cacheFactory,
    });
    const dormantView = (await coldService.status(started.run_id)) as Record<string, unknown>;
    expect((dormantView.artifacts as { path: string }[]).map((entry) => entry.path)).toEqual([
      "/s1.txt",
      "/s2.txt",
    ]);
    close();
  });

  it("a run with no artifacts writes a byte-identical pause_payload_json (contra-assertion)", async () => {
    const { service, repository, close } = harness(cleanRuntimeStub());
    const started = service.start({
      meta: { name: "clean-durable" },
      nodes: [{ id: "a", type: "agent", prompt: "x" }],
    });
    if ("error" in started) throw new Error(started.error);
    await service.status(started.run_id, true);
    const line = repository.getRunState(started.run_id) as Record<string, unknown>;
    const payload = JSON.parse(String(line.pause_payload_json)) as Record<string, unknown>;
    // Exact key set AND order — never `artifacts`/`artifact_faults` (nor
    // `pivots`) for a run that produced none, so a pre-#463 run's payload
    // shape never changes for a run that never used the new fields.
    expect(Object.keys(payload)).toEqual([
      "checkpoint",
      "resume_at",
      "attempts",
      "leaf_respawns",
      "sandbox_refusals",
      "prior_faults",
      "prior_fault_kinds",
      "prior_degraded",
    ]);
    close();
  });
});
