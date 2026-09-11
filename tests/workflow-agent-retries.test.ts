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
import { describe, expect, it, vi } from "vitest";

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

/** Same shape as `PauseOnFirstCollectRuntime`, but the first attempt's
 * `collect()` calls `cancel()` instead of `requestPause()`. `cancel()`
 * (engine.ts:138-141) never routes through `pause()` — it flips
 * `control.cancelled` directly and never touches `result.pauseFault` — so a
 * guard that only reads `pauseFault` (pre-#336) cannot see this stop at
 * all, on either `runAgent` or `runPipeline`. */
class CancelOnFirstCollectRuntime implements ChildRuntime {
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
    this.engine?.cancel();
    return { status: "complete", output: "" };
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

/** First `collect()` outlasts a tiny `pipelineTimeoutSeconds` deadline —
 * `runPipeline`'s own race (engine.ts:~596-604) fires first, sets
 * `expired = true` and cancels active leaves, WHILE this attempt is still
 * in flight. Only once the test explicitly releases it (late, with an
 * EMPTY — not null — output) does the stage's retry loop reach
 * `attempt > 0` for a second try: `expired` is already true by then, so the
 * guard must see it through the SAME `aborted` callback `collectLeaf` itself
 * already checks (engine.ts:~555), or it credits a respawn `collectLeaf`'s
 * own aborted short-circuit refuses to spawn.
 *
 * No real clock: `collect()` returns a promise that stays pending until the
 * test calls `releaseFirstCollect()`. The test awaits `collectStarted` to
 * know the attempt is in flight before advancing fake timers past the
 * pipeline deadline — the race is driven by explicit signals, not by
 * outrunning a fixed wall-clock margin. */
class ExpiresOnFirstCollectRuntime implements ChildRuntime {
  readonly spawned: ChildSpawnRequest[] = [];
  readonly collectStarted: Promise<void>;
  private notifyStarted: (() => void) | null = null;
  private resolveCollect: ((result: ChildResult) => void) | null = null;

  constructor() {
    this.collectStarted = new Promise((resolve) => {
      this.notifyStarted = resolve;
    });
  }

  spawn(request: ChildSpawnRequest): string {
    const id = `leaf-${String(this.spawned.length + 1)}`;
    this.spawned.push(request);
    return id;
  }

  collect(_id: string, _options: ChildCollectOptions): Promise<ChildResult> {
    return new Promise((resolve) => {
      this.resolveCollect = resolve;
      this.notifyStarted?.();
    });
  }

  /** Resolves the in-flight first `collect()` late, empty — after the test
   * has already forced the pipeline deadline to expire. */
  releaseFirstCollect(): void {
    this.resolveCollect?.({ status: "complete", output: "" });
    this.resolveCollect = null;
  }

  steer(): void {}
  cancel(): void {}
  installLeafSandbox(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

/** Settles every currently-queued microtask, as many times as there are
 * chained `await` hops in the engine's background continuation — no real
 * clock involved, just draining the microtask queue deterministically. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await Promise.resolve();
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

  it("does not credit a respawn when cancel() fires between attempts (#336)", async () => {
    const runtime = new CancelOnFirstCollectRuntime();
    const engine = new WorkflowEngine({ runtime });
    runtime.setEngine(engine);
    const spec = parsed({
      meta: { name: "agent-cancel-between-attempts" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 1 }],
    });
    const result = await engine.run(spec);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.outputs.a).toBeNull();
    expect(result.status).toBe("cancelled");
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(0);
  });
});

// Issue #336: `runNested` (engine.ts:~857-873) gives the child engine its
// OWN `RunResult`, but shares the PARENT's `control` object by reference —
// a `requestPause()` on the PARENT flips `control.paused` on the very same
// object the CHILD's `runAgent` reads, yet the child's own
// `result.pauseFault` (pre-#336's only signal) stays null the whole time.
// A retry guard reading only `pauseFault` credits a phantom respawn to the
// NESTED run for every in-flight `agent` node once the operator pauses from
// outside it — the parent's own `runNested` then folds that count back into
// its own `result.leafRespawns` (engine.ts:889), so the corruption surfaces
// at the root too.
describe("nested workflow respawn guard covers a PARENT pause (#336)", () => {
  it("does not credit a respawn in a nested agent when the PARENT pauses between attempts", async () => {
    const innerSpec = {
      meta: { name: "inner" },
      nodes: [{ id: "a", type: "agent", prompt: "x", retries: 1 }],
    };
    const runtime = new PauseOnFirstCollectRuntime();
    const engine = new WorkflowEngine({ runtime, loader: () => innerSpec });
    runtime.setEngine(engine);
    const spec = parsed({
      meta: { name: "outer-nested-pause" },
      nodes: [{ id: "sub", type: "workflow", ref: "inner" }],
    });
    const result = await engine.run(spec);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.status).toBe("paused");
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

  it("does not credit a respawn when cancel() fires between stage attempts (#336)", async () => {
    const runtime = new CancelOnFirstCollectRuntime();
    const engine = new WorkflowEngine({ runtime });
    runtime.setEngine(engine);
    const spec = parsed({
      meta: { name: "pipeline-cancel-between-attempts" },
      nodes: [
        { id: "p", type: "pipeline", items: ["a"], stages: [{ prompt: "${item}", retries: 1 }] },
      ],
    });
    const result = await engine.run(spec);
    expect(runtime.spawned).toHaveLength(1);
    expect(result.outputs.p).toEqual([null]);
    expect(result.status).toBe("cancelled");
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(0);
  });

  it("does not credit a respawn when the pipeline deadline expires between stage attempts (#336)", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new ExpiresOnFirstCollectRuntime();
      const spec = parsed({
        meta: { name: "pipeline-expired-between-attempts" },
        nodes: [
          { id: "p", type: "pipeline", items: ["a"], stages: [{ prompt: "${item}", retries: 1 }] },
        ],
      });
      const runPromise = new WorkflowEngine({ runtime, pipelineTimeoutSeconds: 0.02 }).run(spec);
      // Wait for attempt 0's `collect()` to actually be in flight before
      // forcing the deadline — the bug this guards against only exists
      // while the first attempt is still pending, not before.
      await runtime.collectStarted;
      // Fires the pipeline's own deadline race deterministically — no
      // waiting on the runtime's slow `collect()` to lose a real race.
      await vi.advanceTimersByTimeAsync(20);
      const result = await runPromise;
      expect(result.outputs.p).toEqual([null]);
      expect(result.faults.some((fault) => fault.includes("pipeline timeout"))).toBe(true);
      // `runPipeline` already returned (the deadline race won). Now let the
      // FIRST attempt's `collect()` resolve late and empty, which drives the
      // background retry attempt (`attempt > 0`) that must see `expired`
      // and refuse to spawn or credit a respawn.
      runtime.releaseFirstCollect();
      await flushMicrotasks();
      // Asserted here, AFTER the background retry has settled — not right
      // after `runPromise` resolves, where a second spawn is impossible by
      // construction (attempt 1 hasn't even been reached yet). This is what
      // keeps the guard's OWN check (`collectLeaf`'s `stoppedByControl` at
      // engine.ts:242, via `options.aborted`) covered: without it, the
      // late-settling attempt 0 would let a second leaf spawn here while
      // `leafRespawns` stays 0 below.
      expect(runtime.spawned).toHaveLength(1);
      expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
