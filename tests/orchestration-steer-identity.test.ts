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
//    into a leaf's PENDING inbox with no ceiling — invariant 3 (budget/
//    fan-out never unbounded) had no enforcement point for operator-driven
//    steers.
//
// PR #431 round 2 (revisor, reproduced): an earlier version of this file
// capped the LIFETIME count of accepted steer() calls, which (a) let
// `steer_session`/`delegate_task`'s resume path treat a refusal as an
// ordinary success (`{queued: false}` is indistinguishable from a
// resurrection) and (b) permanently killed a leaf's 11th legitimate
// `delegate_task` resume turn. The cap now bounds `entry.inbox.length`
// (PENDING, undrained texts) only — a drain frees a slot, and a
// resurrection never touches the inbox at all, so it is never capped.
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
    // A snapshot, not a handle: never the caller's own object, and the
    // caller can never go on mutating it after the fact.
    expect(snapshot).not.toBe(request.causalContext);
    expect(Object.isFrozen(snapshot)).toBe(true);

    handle.dispose();
    const afterDispose = (await runtime.causalSnapshot?.(id)) ?? null;
    expect(afterDispose).toBeNull();
  });

  it("devolve null para um sub_id desconhecido — e exige que o método exista de verdade", async () => {
    const runtime: ChildRuntime = new OrchestrationChildRuntime(
      makeCore(() => Promise.resolve(okResult())),
    );
    // `causalSnapshot?.(id) ?? null` alone is tautologically `null` on a
    // base that never implements the method at all (PR #431 round 1
    // review, non-blocking) — this line forces the method to actually
    // exist before the `?? null` fallback can hide its absence.
    expect(typeof runtime.causalSnapshot).toBe("function");
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

describe("OrchestrationCore.steer — teto da fila PENDENTE por folha (issue #422, PR #431 round 2)", () => {
  it("recusa o steer que estouraria o teto de pendentes numa folha ocupada, sem derrubar os já enfileirados, e volta a aceitar depois de um dreno", () => {
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

    // The drain above emptied the pending queue — a fresh steer must be
    // accepted again, not refused forever. A LIFETIME counter (PR #431
    // round 1) would still refuse here, since 10 calls were already
    // accepted before the drain; this is exactly the regression round 2
    // fixes (a `delegate_task` resume loop dying permanently on its 11th
    // turn even though every turn drained cleanly).
    const afterDrain = core.steer(subId, "STEER-12");
    expect(afterDrain).toEqual({ queued: true });

    barrier.resolve(okResult());
  });
});
