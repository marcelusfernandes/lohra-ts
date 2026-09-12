// Issue #521 (M16-S6, épico #490, ADR 0005): `OrchestrationChildRuntime.collect`
// applies `options.timeoutSeconds` — a leaf stuck mid-stream past the deadline
// comes back `{status: "running", output: null}` (the shape `engine.ts:273`
// already treats as a timeout and reacts to by calling `cancel()` ITSELF —
// this runtime never cancels on its own). Molded on
// `tests/workflow-orchestration-runtime.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChildRunner, CollectResult } from "../src/orchestration/core.js";
import { OrchestrationCore } from "../src/orchestration/core.js";
import { OrchestrationChildRuntime } from "../src/workflow/orchestration-runtime.js";
import type {
  CausalContext,
  ChildCollectOptions,
  ChildSpawnRequest,
} from "../src/workflow/runtime.js";

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

describe("OrchestrationChildRuntime.collect — timeoutSeconds (issue #521)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a leaf stuck mid-stream comes back running within the deadline, without cancelling it", async () => {
    // never resolves — a real stuck stream. Real timers: the deadline race
    // itself is under test here, not a fake clock's advance.
    const runChild: ChildRunner = () => new Promise<CollectResult>(() => undefined);
    const runtime = new OrchestrationChildRuntime(makeCore(runChild));
    const id = runtime.spawn(spawnRequest("r1"));

    const startedAt = performance.now();
    const result = await runtime.collect(id, { wait: true, timeoutSeconds: 0.05 });
    const elapsedMs = performance.now() - startedAt;

    expect(result).toEqual({ status: "running", output: null });
    // AC: "≤ 100 ms" — comfortably above the 50ms deadline itself, well
    // under vitest's own 5s test timeout (the base's failure mode).
    expect(elapsedMs).toBeLessThanOrEqual(100);
  });

  it("a leaf that settles before the deadline returns the real result, and leaves no timer pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const runChild: ChildRunner = () => Promise.resolve(ok("done"));
      const runtime = new OrchestrationChildRuntime(makeCore(runChild));
      const id = runtime.spawn(spawnRequest("r2"));

      const pending = runtime.collect(id, { wait: true, timeoutSeconds: 5 });
      // ConcurrencyGate.run() only actually calls runChild on a later
      // microtask (same note as the sibling test file) — flush microtasks
      // under fake timers without advancing real time past the deadline.
      await vi.advanceTimersByTimeAsync(0);
      const result = await pending;

      expect(result.status).toBe("complete");
      expect(result.output).toBe("done");
      // the deadline's own setTimeout was cleared once the real collect won
      // the race — nothing left pending.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeoutSeconds: 0 never starts a deadline timer — the leaf's own collect is the only race participant", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const runChild: ChildRunner = () => Promise.resolve(ok("no-deadline"));
      const runtime = new OrchestrationChildRuntime(makeCore(runChild));
      const id = runtime.spawn(spawnRequest("r3"));

      const pending = runtime.collect(id, { wait: true, timeoutSeconds: 0 });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(0);
      const result = await pending;

      expect(result.status).toBe("complete");
      expect(result.output).toBe("no-deadline");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an absent timeoutSeconds (a caller that predates this issue) also never starts a deadline timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const runChild: ChildRunner = () => Promise.resolve(ok("legacy"));
      const runtime = new OrchestrationChildRuntime(makeCore(runChild));
      const id = runtime.spawn(spawnRequest("r4"));

      // cast, not a real call: production always passes timeoutSeconds
      // (`ChildCollectOptions`, runtime.ts) — this proves the RUNTIME
      // tolerates a fake/legacy caller that doesn't.
      const legacyOptions = { wait: true } as ChildCollectOptions;
      const pending = runtime.collect(id, legacyOptions);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(0);
      const result = await pending;

      expect(result.status).toBe("complete");
      expect(result.output).toBe("legacy");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
