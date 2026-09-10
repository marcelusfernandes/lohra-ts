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
});
