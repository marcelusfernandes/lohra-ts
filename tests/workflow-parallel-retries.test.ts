// Issue #242: `parallel.retries` (0-3, default 0) — a laço mora em
// `engine-utils.ts` (não `engine.ts`, que está no teto do `arquivo-grande`;
// justificativa na emenda da issue) ao lado de `replayOrCollectBranch`
// (#241). Retry só para branch MORTA (`output === null`) — uma branch com
// saída vazia (dado legítimo sem schema) nunca é refeita. Cada retentativa
// reusa `collectLeaf`, que já chama `gateTokens`/`gateFanout(1, true)` e já
// grava um fault com causa por leaf morto (engine.ts:237-238, :259-278) —
// então o teto de orçamento e o rastro de falha vêm de graça do caminho
// existente; só `leafRespawns` é contado aqui.
import { describe, expect, it } from "vitest";

import {
  Budget,
  WorkflowEngine,
  validateSpec,
  type ChildCollectOptions,
  type ChildResult,
  type ChildRuntime,
  type ChildSpawnRequest,
} from "../src/workflow/index.js";

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

const dead: ChildResult = { status: "failed", output: "boom" };
const ok = (output: unknown): ChildResult => ({ status: "complete", output });

function parsed(raw: unknown) {
  const result = validateSpec(raw);
  if ("issues" in result) throw new Error(result.message);
  return result;
}

describe("parallel.retries (#242)", () => {
  it("retries a dead branch and counts the re-spawn in leaf_respawns", async () => {
    const runtime = new ScriptedRuntime([[dead], [ok("recovered")]]);
    const spec = parsed({
      meta: { name: "retry-dead" },
      nodes: [{ id: "p", type: "parallel", branches: ["a"], retries: 1 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.p).toEqual(["recovered"]);
    expect(runtime.spawned).toHaveLength(2);
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(1);
  });

  it("never retries a live branch with an empty (non-null) output", async () => {
    const runtime = new ScriptedRuntime([[ok("")]]);
    const spec = parsed({
      meta: { name: "no-retry-empty" },
      nodes: [{ id: "p", type: "parallel", branches: ["a"], retries: 2 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.p).toEqual([""]);
    expect(runtime.spawned).toHaveLength(1);
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(0);
  });

  it("exhausts the cap on one branch: null POSITIONALLY beside a live sibling, a fault per dead attempt", async () => {
    const runtime = new ScriptedRuntime([[ok("A")], [dead], [dead]]);
    const spec = parsed({
      meta: { name: "retry-exhausted" },
      nodes: [{ id: "p", type: "parallel", branches: ["a", "b"], retries: 1 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.p).toEqual(["A", null]);
    expect(runtime.spawned).toHaveLength(3);
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(1);
    expect(result.faults.filter((fault) => fault.includes("leaf failed"))).toHaveLength(2);
  });

  it("defaults to zero retries when 'retries' is absent", async () => {
    const runtime = new ScriptedRuntime([[dead], [ok("unused")]]);
    const spec = parsed({
      meta: { name: "no-retries-field" },
      nodes: [{ id: "p", type: "parallel", branches: ["a"] }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.p).toBeNull();
    expect(runtime.spawned).toHaveLength(1);
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(0);
  });

  it("a retry passes through the budget stop-line, same as any other leaf spawn", async () => {
    const expensive: ChildResult = {
      status: "failed",
      output: "boom",
      usage: {
        inputTokens: 1000,
        outputTokens: 1001,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    };
    const runtime = new ScriptedRuntime([[expensive]]);
    const spec = parsed({
      meta: { name: "retry-budget" },
      nodes: [{ id: "p", type: "parallel", branches: ["a"], retries: 1 }],
    });
    // 2000 (the default per-leaf estimate) clears the pre-flight
    // `gateFanout(resolved.length)` in `runParallel` for one branch; the
    // first attempt's real 2001-token cost then exhausts the budget.
    const budget = new Budget({ tokenBudget: 2000 });
    const result = await new WorkflowEngine({ runtime, budget }).run(spec);
    // The retry's own `collectLeaf` call hits `gateTokens()` before
    // spawning a second leaf — same stop-line every other leaf (agent,
    // pipeline stage) already goes through.
    expect(runtime.spawned).toHaveLength(1);
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("token_budget_exhausted");
  });

  it("bounds a sibling's phantom respawns when the run pauses mid fan-out", async () => {
    // `collectLeaf` returns a null leaf with NO spawn, NO fault and NO
    // charge once `this.control.paused` is set (engine.ts:235-236) —
    // indistinguishable from a fresh death by `output === null` alone.
    // Two branches that both die expensively: whichever retry loses the
    // race pauses the run via `gateTokens()`; the guard stops the OTHER
    // branch's loop once `result.pauseFault` is visible — bounding the
    // damage to at most one wasted attempt per branch (2). Without the
    // guard, the base measured 4: the losing branch takes 1 respawn
    // before `gateTokens()` throws and pauses; the other, unaware,
    // spins through all 3 of its own `retries` hitting the paused
    // shortcut each time (1 + 3 = 4) — never a full 6 (3 retries x 2
    // branches), since the losing branch's own throw cuts its loop
    // short too.
    const expensive: ChildResult = {
      status: "failed",
      output: "boom",
      usage: {
        inputTokens: 2000,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    };
    const runtime = new ScriptedRuntime([[expensive], [expensive]]);
    const spec = parsed({
      meta: { name: "retry-pause-race" },
      nodes: [{ id: "p", type: "parallel", branches: ["a", "b"], retries: 3 }],
    });
    const budget = new Budget({ tokenBudget: 4000 });
    const result = await new WorkflowEngine({ runtime, budget }).run(spec);
    const respawns = (result as unknown as { leafRespawns: number }).leafRespawns;
    expect(respawns).toBeLessThanOrEqual(2); // base measured 4 (1 + 3), not 6
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("token_budget_exhausted");
  });
});

// Issue #313: a leaf that dies by TIMEOUT (collect() returns "running" —
// runtime.cancel then tears it down) still spent real tokens up to that
// point. `collectLeaf` used to return a bare zero `usage()` for that
// attempt without ever calling `account()` — the run's own `budget.charge()`
// still counted the leaf against `affordableLeaves`, but the tokens
// themselves vanished from `tokensIn`/`tokensOut` and `gateTokens` never saw
// them. `retries: 1` here is the same "second collectLeaf call hits
// gateTokens() before spawning" pattern the retry-budget test above uses —
// the only way to observe a debit from OUTSIDE the engine without a spy.
describe("timeout cost enters the budget (#313)", () => {
  it("debits a timed-out leaf's measured usage — the next spawn's gateTokens sees it and pauses", async () => {
    const timedOut: ChildResult = {
      status: "running",
      output: null,
      usage: {
        inputTokens: 2000,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    };
    const runtime = new ScriptedRuntime([[timedOut]]);
    const spec = parsed({
      meta: { name: "timeout-budget" },
      nodes: [{ id: "p", type: "parallel", branches: ["a"], retries: 1 }],
    });
    const budget = new Budget({ tokenBudget: 2000 });
    const result = await new WorkflowEngine({ runtime, budget }).run(spec);
    // The retry's own gateTokens() throws before a second leaf spawns —
    // proof the FIRST (timed-out) attempt's usage was actually debited.
    expect(runtime.spawned).toHaveLength(1);
    expect(result.status).toBe("paused");
    expect(result.pauseReason).toBe("token_budget_exhausted");
  });

  it("charges a timed-out leaf's usage exactly once, never doubled", async () => {
    const timedOut: ChildResult = {
      status: "running",
      output: null,
      usage: {
        inputTokens: 500,
        outputTokens: 25,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    };
    const runtime = new ScriptedRuntime([[timedOut]]);
    const spec = parsed({
      meta: { name: "timeout-single-charge" },
      nodes: [{ id: "p", type: "parallel", branches: ["a"], retries: 0 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.tokensIn).toBe(500);
    expect(result.tokensOut).toBe(25);
  });

  it("marks usageUncertain instead of a silent zero when the runtime reports no usage on timeout", async () => {
    const timedOut: ChildResult = { status: "running", output: null };
    const runtime = new ScriptedRuntime([[timedOut]]);
    const spec = parsed({
      meta: { name: "timeout-uncertain" },
      nodes: [{ id: "p", type: "parallel", branches: ["a"], retries: 0 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.p).toBeNull();
    expect(result.usageUncertainLeaves).toBe(1);
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });
});
