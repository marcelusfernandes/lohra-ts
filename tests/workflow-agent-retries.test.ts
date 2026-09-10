// Issue #321: `runAgent` (engine.ts:448-461) credited a respawn to
// `leafRespawns` BEFORE knowing whether the next attempt would actually
// spawn a leaf (`if (attempt > 0) this.result.leafRespawns += 1;`, ahead of
// the `collectLeaf` call). `collectLeaf` returns a null leaf with NO spawn
// once `this.control.paused` is set (engine.ts:235-236) — same
// already-paused short-circuit `stillDying` (engine-utils.ts) guards for
// `parallel` branches since #315. `runAgent` never spins through its own
// `retries` cap on that shortcut (it exits on `null` immediately), so the
// damage is bounded to exactly one phantom respawn per in-flight `agent`
// node, but it is still one too many. The run pauses HERE via the external
// `requestPause()` API (the operator hitting pause, or a checkpoint from
// elsewhere in the graph) fired synchronously while the first attempt's
// (empty) result is being collected — before `runAgent`'s loop reaches its
// `attempt > 0` check for the retry that will never spawn.
import { describe, expect, it } from "vitest";

import {
  WorkflowEngine,
  validateSpec,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
} from "../src/workflow/index.js";

/** Attempt 0 spawns for real and comes back EMPTY (not null) — the only
 * output that sends `runAgent` into its retry loop. `collect()` requests a
 * pause as part of returning that result, synchronously: by the time
 * `runAgent` reaches `attempt > 0` for the retry, `control.paused` (and
 * `result.pauseFault`) are already set, so the retry's own `collectLeaf`
 * call hits the paused short-circuit and never spawns. */
class PauseOnFirstCollectRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
  private engine: WorkflowEngine | null = null;

  setEngine(engine: WorkflowEngine): void {
    this.engine = engine;
  }

  spawn(request: ChildSpawnRequest): string {
    const id = `leaf-${String(this.spawned.length + 1)}`;
    this.spawned.push(request);
    return id;
  }

  collect(_id: string, _options: ChildCollectOptions): ChildResult {
    this.engine?.requestPause();
    return { status: "complete", output: "" };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

/** Same shape as `workflow-parallel-retries.test.ts`'s `ScriptedRuntime` —
 * scripted per-spawn results, one script consumed per leaf. Used below to
 * pin the two behaviors OUTSIDE a pause that this fix must never touch:
 * empty output retries up to the cap, a dead (null) leaf never retries. */
class ScriptedRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
  private readonly scripts: ChildResult[][];
  private readonly byId = new Map<string, ChildResult[]>();

  constructor(scripts: ChildResult[][]) {
    this.scripts = scripts.map((script) => [...script]);
  }

  spawn(request: ChildSpawnRequest): string {
    const id = `leaf-${String(this.spawned.length + 1)}`;
    this.spawned.push(request);
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

const empty: ChildResult = { status: "complete", output: "" };
const dead: ChildResult = { status: "failed", output: "boom" };

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

describe("agent retries never spin past a pause (#321)", () => {
  it("does not credit a respawn when the run pauses between attempts", async () => {
    const runtime = new PauseOnFirstCollectRuntime();
    const engine = new WorkflowEngine({ runtime });
    runtime.setEngine(engine);
    const spec = parsed({
      meta: { name: "agent-pause-between-attempts" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 1 }],
    });
    const result = await engine.run(spec);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.outputs.a).toBeNull();
    expect(result.status).toBe("paused");
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(0);
  });

  it("still retries an agent up to the cap on repeated empty output, outside any pause", async () => {
    const runtime = new ScriptedRuntime([[empty], [empty], [empty]]);
    const spec = parsed({
      meta: { name: "agent-empty-until-cap" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 2 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(runtime.spawned).toHaveLength(3);
    expect(result.outputs.a).toBeNull();
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(2);
    expect(result.faults).toContain("a: empty output after retry");
  });

  it("still never retries a dead (null) agent leaf, outside any pause", async () => {
    const runtime = new ScriptedRuntime([[dead]]);
    const spec = parsed({
      meta: { name: "agent-dead-no-retry" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 1 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.outputs.a).toBeNull();
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(0);
  });
});

// Issue #334: the same phantom-respawn shape as #321, but in `runPipeline`'s
// per-stage retry loop (engine.ts:~545) instead of `runAgent`'s. It credits
// `leafRespawns` for the retry attempt BEFORE knowing `collectLeaf` will hit
// the already-paused short-circuit (engine.ts:235-236) and return a null
// leaf with NO spawn. Flagged by the implementer of PR #333 while fixing
// #321; the guard is the same one already applied to `runAgent`
// (`&& this.result.pauseFault === null` on the increment).
describe("pipeline stage retries never spin past a pause (#334)", () => {
  it("does not credit a respawn when the run pauses between stage attempts", async () => {
    const runtime = new PauseOnFirstCollectRuntime();
    const engine = new WorkflowEngine({ runtime });
    runtime.setEngine(engine);
    const spec = parsed({
      meta: { name: "pipeline-pause-between-attempts" },
      nodes: [
        { id: "p", type: "pipeline", items: ["a"], stages: [{ prompt: "${item}", retries: 1 }] },
      ],
    });
    const result = await engine.run(spec);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.outputs.p).toEqual([null]);
    expect(result.status).toBe("paused");
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(0);
  });

  it("still retries a pipeline stage up to the cap on repeated empty output, outside any pause", async () => {
    const runtime = new ScriptedRuntime([[empty], [empty], [empty]]);
    const spec = parsed({
      meta: { name: "pipeline-empty-until-cap" },
      nodes: [
        { id: "p", type: "pipeline", items: ["a"], stages: [{ prompt: "${item}", retries: 2 }] },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(runtime.spawned).toHaveLength(3);
    expect(result.outputs.p).toEqual([null]);
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(2);
    expect(result.faults).toContain("p: empty output after retry");
  });

  it("still never retries a dead (null) pipeline stage leaf, outside any pause", async () => {
    const runtime = new ScriptedRuntime([[dead]]);
    const spec = parsed({
      meta: { name: "pipeline-dead-no-retry" },
      nodes: [
        { id: "p", type: "pipeline", items: ["a"], stages: [{ prompt: "${item}", retries: 1 }] },
      ],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.outputs.p).toEqual([null]);
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(0);
  });
});
