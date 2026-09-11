// Issue #422 (M10-S1): causal identity across steer.
//
// Three gaps closed here:
// 1. `OrchestrationChildRuntime.causalSnapshot(id)` did not exist at all
//    (`causalSnapshot?` is optional on `ChildRuntime`, runtime.ts:100, so
//    nothing failed to compile — it was simply never implemented). A
//    supervision tool resolving `node_id -> sub_id` (S3) has nothing to
//    read without it.
// 2. `OrchestrationChildRuntime.steer(id, prompt)` discarded its 3rd
//    argument (orchestration-runtime.ts:230-232 before this issue) instead
//    of forwarding it to `core.steer`.
// 3. `OrchestrationCore.steer` (core.ts:257-272 before this issue) queued
//    into a leaf's inbox with no ceiling — invariant 3 (budget/fan-out never
//    unbounded) had no enforcement point for operator-driven steers.
//
// `runtime` is typed as the `ChildRuntime` PORT throughout, not the
// concrete `OrchestrationChildRuntime` class: `causalSnapshot` is optional
// on the port, so `runtime.causalSnapshot?.(id)` compiles against a base
// that never implements it (the call just evaluates to `undefined`), and
// the base's narrower 2-arg `steer(id, prompt)` is still assignable to the
// port's 3-arg signature (a function accepting fewer parameters always
// satisfies a type calling it with more — TypeScript's own contravariance
// rule for method params). Both gaps therefore fail by ASSERTION on the
// base commit, never by a compile error.
import { describe, expect, it, vi } from "vitest";

import {
  OrchestrationCore,
  type ChildRunner,
  type CollectResult,
} from "../src/orchestration/core.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import type { CausalContext, ChildRuntime, ChildSpawnRequest } from "../src/workflow/runtime.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function okResult(overrides: Partial<CollectResult> = {}): CollectResult {
  return {
    status: "complete",
    output: "done",
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
    ...overrides,
  };
}

const stubPrompt = (): string => "SUBAGENT_SYSTEM_STUB";

function makeCore(runChild: ChildRunner): OrchestrationCore {
  let n = 0;
  return new OrchestrationCore({
    runChild,
    idSource: () => {
      n += 1;
      return `leaf-${String(n)}`;
    },
    maxSubsessions: 200,
    maxParallel: 200,
    buildSubagentPrompt: stubPrompt,
  });
}

function causal(runId: string): CausalContext {
  return Object.freeze({
    runId,
    segmentId: "seg-1",
    nodePath: Object.freeze(["a"]),
    cellId: "a:0",
    role: "leaf",
    attempt: 2,
    turn: 0,
  });
}

function spawnRequest(runId: string, prompt = "do it"): ChildSpawnRequest {
  return { prompt, causalContext: causal(runId) };
}

describe("OrchestrationChildRuntime.causalSnapshot", () => {
  it("devolve a identidade causal do spawn enquanto a folha está registrada, e null depois do dispose", async () => {
    const runtime: ChildRuntime = new OrchestrationChildRuntime(
      makeCore(() => Promise.resolve(okResult())),
    );
    const handle = runtime.installLeafSandbox?.({
      runId: "r1",
      fence: 1,
      wrap: (base) => base,
    });
    if (handle === undefined) throw new Error("installLeafSandbox missing");

    const request = spawnRequest("r1");
    const id = await runtime.spawn(request);

    const snapshot = (await runtime.causalSnapshot?.(id)) ?? null;
    expect(snapshot).toEqual(request.causalContext);

    handle.dispose();
    const afterDispose = (await runtime.causalSnapshot?.(id)) ?? null;
    expect(afterDispose).toBeNull();
  });

  it("devolve null para um sub_id desconhecido", async () => {
    const runtime: ChildRuntime = new OrchestrationChildRuntime(
      makeCore(() => Promise.resolve(okResult())),
    );
    const snapshot = (await runtime.causalSnapshot?.("no-such-leaf")) ?? null;
    expect(snapshot).toBeNull();
  });
});

describe("OrchestrationChildRuntime.steer — repassa a identidade causal", () => {
  it("passa o 3º argumento (causalContext) direto para core.steer", async () => {
    const core = makeCore(() => new Promise<CollectResult>(() => undefined));
    const steerSpy = vi.spyOn(core, "steer");
    const runtime: ChildRuntime = new OrchestrationChildRuntime(core);

    const request = spawnRequest("r2");
    const id = await runtime.spawn(request);

    await runtime.steer(id, "cutuca a folha", request.causalContext);

    expect(steerSpy).toHaveBeenCalledWith(id, "cutuca a folha", request.causalContext);
  });
});

describe("OrchestrationCore.steer — teto de steers por folha (issue #422)", () => {
  it("recusa o 11º steer numa folha ocupada com refused: 'steer_cap', sem derrubar os 10 anteriores da inbox", () => {
    const barrier = deferred<CollectResult>();
    const core = new OrchestrationCore({
      runChild: () => barrier.promise,
      idSource: () => "leaf-cap",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    const { subId } = core.spawn({ prompt: "occupies the leaf" });

    const accepted: ({ readonly queued: boolean; readonly refused?: "steer_cap" } | null)[] = [];
    for (let i = 1; i <= 10; i += 1) {
      accepted.push(core.steer(subId, `STEER-${String(i)}`));
    }
    for (const outcome of accepted) {
      expect(outcome).toEqual({ queued: true });
    }

    const eleventh = core.steer(subId, "STEER-11");
    expect(eleventh).toEqual({ queued: false, refused: "steer_cap" });

    const drained = core.drainInboxFor(subId);
    expect(drained).toHaveLength(1);
    const message = drained[0] as { readonly content: string };
    for (let i = 1; i <= 10; i += 1) {
      expect(message.content).toContain(`STEER-${String(i)}`);
    }
    expect(message.content).not.toContain("STEER-11");

    barrier.resolve(okResult());
  });
});
