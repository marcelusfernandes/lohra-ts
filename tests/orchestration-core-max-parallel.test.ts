import { describe, expect, it } from "vitest";

import { OrchestrationCore, type CollectResult } from "../src/orchestration/core.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

const okResult = (overrides: Partial<CollectResult> = {}): CollectResult => ({
  status: "complete",
  output: "done",
  tokensIn: 11,
  tokensOut: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  provider: "fakeprov",
  model: "fake-model-a",
  forcedFallback: false,
  errorKind: null,
  retryAfter: null,
  ...overrides,
});

const stubPrompt = (): string => "SUBAGENT_SYSTEM_STUB";

describe("OrchestrationCore max-parallel fan-out (contract decision 8 / assertions 24-27)", () => {
  it("bounds concurrent runChild invocations to maxParallel, queuing the rest", async () => {
    const barriers = [deferred<CollectResult>(), deferred<CollectResult>(), deferred<CollectResult>()];
    let started = 0;
    let idCalls = 0;
    const core = new OrchestrationCore({
      runChild: () => {
        const barrier = barriers[started];
        started += 1;
        return barrier?.promise ?? Promise.resolve(okResult());
      },
      idSource: () => {
        const id = `kid-${String(idCalls)}`;
        idCalls += 1;
        return id;
      },
      maxSubsessions: 200,
      maxParallel: 2,
      buildSubagentPrompt: stubPrompt,
    });

    const first = core.spawn({ prompt: "one" });
    const second = core.spawn({ prompt: "two" });
    const third = core.spawn({ prompt: "three" });

    await flushMicrotasks();
    // Only 2 of the 3 children have actually started their runChild call —
    // the third is queued in the pool, exactly like the oracle's
    // --max-parallel-saturated pool.
    expect(started).toBe(2);

    barriers[0]?.resolve(okResult({ output: "first" }));
    await flushMicrotasks();
    expect(started).toBe(3); // releasing a slot admits the third

    barriers[1]?.resolve(okResult({ output: "second" }));
    barriers[2]?.resolve(okResult({ output: "third" }));

    expect((await core.collect(first.subId, true)).kind).toBe("settled");
    expect((await core.collect(second.subId, true)).kind).toBe("settled");
    expect((await core.collect(third.subId, true)).kind).toBe("settled");
  });

  it("spawn still returns a sub_id immediately even when the pool is saturated — the child sits queued, not blocked (L6's queued-in-pool case)", () => {
    const barrier = deferred<CollectResult>();
    const core = new OrchestrationCore({
      runChild: () => barrier.promise,
      idSource: () => "kid-0",
      maxSubsessions: 200,
      maxParallel: 1,
      buildSubagentPrompt: stubPrompt,
    });

    core.spawn({ prompt: "one" });
    // Second spawn saturates the pool (maxParallel: 1) — must still return
    // synchronously, proven by the fact this line executes at all without
    // ever awaiting the first child's completion.
    const second = core.spawn({ prompt: "two" });
    expect(second.subId).toBeTruthy();
  });

  it("a queued (not-yet-started) child is collectable as pending, same as a running one", async () => {
    const barrier = deferred<CollectResult>();
    let idCalls = 0;
    const core = new OrchestrationCore({
      runChild: () => barrier.promise,
      idSource: () => {
        const id = `kid-${String(idCalls)}`;
        idCalls += 1;
        return id;
      },
      maxSubsessions: 200,
      maxParallel: 1,
      buildSubagentPrompt: stubPrompt,
    });

    core.spawn({ prompt: "one" }); // occupies the single slot
    const queued = core.spawn({ prompt: "two" }); // never actually started yet

    const outcome = await core.collect(queued.subId, false);
    expect(outcome.kind).toBe("pending");

    barrier.resolve(okResult());
  });
});
