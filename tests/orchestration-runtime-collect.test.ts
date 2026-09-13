// Issue #568 (M16 pós-revisão, épico #561, sub S3+S6; vereditos das PRs
// #528/#543, r2 de #556): `OrchestrationChildRuntime.cancel`
// (`orchestration-runtime.ts:468-478`) aborts the leaf's own controller and
// WAITS for real settlement up to `CANCEL_SETTLE_TIMEOUT_MS` (2 s) — until
// now, no test drove a leaf that genuinely never settles under FAKE timers,
// so neither the `Promise.race` (only that race can ever resolve `cancel()`
// for such a leaf) nor the `ceiling.clear()` cleanup (a leaf that settles
// fast must never leave a live timer behind) had a test able to kill a
// mutant of either. Molded on `tests/workflow-orchestration-runtime-timeout.test.ts`
// (the sibling ceiling on `collect()`, issue #521) — same fake-timer/flush
// convention (`ConcurrencyGate.run()` only actually calls `runChild` on a
// later microtask).
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChildRunner, CollectResult } from "../src/orchestration/core.js";
import { OrchestrationCore } from "../src/orchestration/core.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import type { CausalContext, ChildSpawnRequest } from "../src/workflow/runtime.js";

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

function causal(runId: string): CausalContext {
  return Object.freeze({
    runId,
    segmentId: "seg-1",
    nodePath: Object.freeze(["a"]),
    cellId: "a:0",
    role: "leaf",
    attempt: 0,
    turn: 0,
  });
}

function spawnRequest(runId: string, prompt = "do it"): ChildSpawnRequest {
  return { prompt, causalContext: causal(runId) };
}

describe("OrchestrationChildRuntime.cancel — CANCEL_SETTLE_TIMEOUT_MS ceiling (issue #568)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves at the ceiling for a leaf that never settles, aborting core.cancel exactly once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Never resolves — a real stuck leaf. `core.cancel()` only aborts its
      // controller (core.ts:424-427); it never forces this promise to
      // settle, so only the ceiling can ever resolve `cancel()` here.
      const runChild: ChildRunner = () => new Promise<CollectResult>(() => undefined);
      const core = makeCore(runChild);
      const cancelSpy = vi.spyOn(core, "cancel");
      const runtime = new OrchestrationChildRuntime(core);
      const id = runtime.spawn(spawnRequest("r1"));

      const pending = runtime.cancel(id);
      // Flush the microtask that actually issues runChild (ConcurrencyGate),
      // then advance straight to the ceiling.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000); // CANCEL_SETTLE_TIMEOUT_MS

      await expect(pending).resolves.toBeUndefined();
      // "sem cancelar de novo": the ceiling winning the race never triggers
      // a second core-level cancel of the same leaf.
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).toHaveBeenCalledWith(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its ceiling timer once the leaf settles well under it, leaving nothing pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const runChild: ChildRunner = () => Promise.resolve(ok("done"));
      const runtime = new OrchestrationChildRuntime(makeCore(runChild));
      const id = runtime.spawn(spawnRequest("r2"));

      const pending = runtime.cancel(id);
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toBeUndefined();

      // the ceiling's own setTimeout was cleared once the real collect won
      // the race — nothing left pending (a removed `ceiling.clear()` would
      // leak this timer).
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
