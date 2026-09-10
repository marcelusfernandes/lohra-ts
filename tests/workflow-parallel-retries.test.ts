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

  it("exhausts the cap, returns null positionally, and leaves a fault", async () => {
    const runtime = new ScriptedRuntime([[dead], [dead]]);
    const spec = parsed({
      meta: { name: "retry-exhausted" },
      nodes: [{ id: "p", type: "parallel", branches: ["a"], retries: 1 }],
    });
    const result = await new WorkflowEngine({ runtime }).run(spec);
    expect(result.outputs.p).toBeNull();
    expect(runtime.spawned).toHaveLength(2);
    expect((result as unknown as { leafRespawns: number }).leafRespawns).toBe(1);
    expect(result.faults.some((fault) => fault.includes("leaf failed"))).toBe(true);
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
});
