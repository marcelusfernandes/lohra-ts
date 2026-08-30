import { describe, expect, it } from "vitest";

import { OrchestrationCore, type CollectResult } from "../src/orchestration/core.js";

const stubPrompt = (): string => "SUBAGENT_SYSTEM_STUB";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The concurrency gate's admission check is itself async (an `await` always
// yields at least one microtask tick, even on an already-resolved promise),
// so runChild starts one tick after spawn() returns, not synchronously
// within it. This is still non-blocking per the contract (spawn's own call
// never waits on the child), just not same-tick — flush enough microtasks
// for that one hop to unwind before asserting on child-side effects.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
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

describe("OrchestrationCore.spawn", () => {
  it("returns a sub_id immediately, before the child's run resolves — non-blocking (L5)", async () => {
    const child = deferred<CollectResult>();
    const order: string[] = [];
    const core = new OrchestrationCore({
      runChild: () => {
        order.push("child-started");
        return child.promise;
      },
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    order.push("before-spawn");
    const { subId } = core.spawn({ prompt: "do the thing" });
    order.push("after-spawn");

    expect(subId).toBe("aaaa");
    // spawn's own call never touches the child's execution — "before-spawn"
    // and "after-spawn" are adjacent, with zero child activity between them.
    expect(order).toEqual(["before-spawn", "after-spawn"]);

    // The child only starts after the concurrency gate admits it (at least
    // one microtask tick, by design — see flushMicrotasks) — still strictly
    // after spawn() returned, proving non-blocking by order, not latency.
    await flushMicrotasks();
    expect(order).toEqual(["before-spawn", "after-spawn", "child-started"]);

    child.resolve(okResult());
    await Promise.resolve();
  });

  it("evicts only a terminal entry when over the registry cap, and the running one survives (L9)", async () => {
    const child1 = deferred<CollectResult>();
    let idCalls = 0;
    let runCalls = 0;
    const core = new OrchestrationCore({
      // runChild's own counter is independent of idSource's: the gate defers
      // the actual runChild invocation by a microtask tick, but idSource is
      // still called synchronously inside spawn() — the two counters must
      // not be conflated.
      runChild: () => {
        runCalls += 1;
        return runCalls === 1 ? child1.promise : Promise.resolve(okResult());
      },
      idSource: () => {
        const id = idCalls === 0 ? "kid-1" : "kid-2";
        idCalls += 1;
        return id;
      },
      maxSubsessions: 1,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const first = core.spawn({ prompt: "one" });
    // First is still running; spawning a second over cap must not evict it.
    const second = core.spawn({ prompt: "two" });
    await flushMicrotasks();

    expect(core.size).toBe(2);
    expect((await core.collect(first.subId, false)).kind).toBe("pending");
    expect((await core.collect(second.subId, true)).kind).toBe("settled");

    child1.resolve(okResult());
  });

  it("evicts the terminal entry's registry record when a new spawn exceeds the cap (L9)", async () => {
    let call = 0;
    const ids = ["kid-1", "kid-2"];
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult()),
      idSource: () => {
        const id = ids[call] ?? "unused";
        call += 1;
        return id;
      },
      maxSubsessions: 1,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });

    const first = core.spawn({ prompt: "one" });
    await core.collect(first.subId, true); // first is now terminal
    const second = core.spawn({ prompt: "two" }); // over cap, evicts the terminal first
    await Promise.resolve();

    expect(core.size).toBe(1);
    expect((await core.collect(first.subId, false)).kind).toBe("not-found");
    expect((await core.collect(second.subId, true)).kind).toBe("settled");
  });
});

describe("OrchestrationCore.collect", () => {
  it("returns not-found for an unknown sub_id", async () => {
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult()),
      idSource: () => "x",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    expect((await core.collect("deadbeef", true)).kind).toBe("not-found");
  });

  it("wait:false on a running child returns pending without blocking", async () => {
    const child = deferred<CollectResult>();
    const core = new OrchestrationCore({
      runChild: () => child.promise,
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    const { subId } = core.spawn({ prompt: "x" });

    const outcome = await core.collect(subId, false);
    expect(outcome.kind).toBe("pending");

    child.resolve(okResult());
  });

  it("wait:true blocks until the child settles, then returns the result", async () => {
    const child = deferred<CollectResult>();
    const core = new OrchestrationCore({
      runChild: () => child.promise,
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    const { subId } = core.spawn({ prompt: "x" });

    let resolved = false;
    const pending = core.collect(subId, true).then((outcome) => {
      resolved = true;
      return outcome;
    });
    await Promise.resolve();
    expect(resolved).toBe(false); // still waiting

    child.resolve(okResult({ output: "the answer" }));
    const outcome = await pending;
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") {
      expect(outcome.result.output).toBe("the answer");
    }
  });

  it("a second wait:true after settlement returns the same cached result without re-running (staleness base case)", async () => {
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult({ output: "first" })),
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    const { subId } = core.spawn({ prompt: "x" });

    const first = await core.collect(subId, true);
    const second = await core.collect(subId, false);
    expect(first.kind).toBe("settled");
    expect(second.kind).toBe("settled");
    if (first.kind === "settled" && second.kind === "settled") {
      expect(second.result).toEqual(first.result);
    }
  });
});

describe("OrchestrationCore subagent prompt freeze (contract decision 25 / assertion 51)", () => {
  it("captures the subagent system prompt once at spawn and never calls the builder again for that sub_id", async () => {
    let calls = 0;
    const capturedPrompts: string[] = [];
    const core = new OrchestrationCore({
      runChild: (_subId, _config, systemPrompt) => {
        capturedPrompts.push(systemPrompt);
        return Promise.resolve(okResult());
      },
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      // Deliberately returns a DIFFERENT string on every call — the
      // strongest possible proof that the registry, not the builder, is
      // what freezes the value. If the mechanism re-called this on a
      // later turn, the captured text would visibly drift.
      buildSubagentPrompt: () => {
        calls += 1;
        return `PROMPT-VERSION-${String(calls)}`;
      },
    });

    const { subId } = core.spawn({ prompt: "x" });

    // buildSubagentPrompt runs synchronously inside spawn(), unaffected by
    // the concurrency gate's async admission — this assertion needs no flush.
    expect(calls).toBe(1);
    // runChild itself is gated (deferred by at least one microtask tick),
    // so the captured-prompt side effect needs a flush before it's visible.
    await flushMicrotasks();
    expect(capturedPrompts).toEqual(["PROMPT-VERSION-1"]);
    // Retrieving the frozen prompt for the same sub_id, as many times as a
    // future steer-resume implementation would need to, never re-invokes
    // the builder and never returns a newer version.
    expect(core.getSubagentPrompt(subId)).toBe("PROMPT-VERSION-1");
    expect(core.getSubagentPrompt(subId)).toBe("PROMPT-VERSION-1");
    expect(calls).toBe(1);
  });

  it("returns undefined for an unknown sub_id", () => {
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult()),
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    expect(core.getSubagentPrompt("deadbeef")).toBeUndefined();
  });

  it("gives each spawned child its own frozen prompt, independent of the others", () => {
    let idCalls = 0;
    let promptCalls = 0;
    const ids = ["kid-1", "kid-2"];
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult()),
      idSource: () => {
        const id = ids[idCalls] ?? "unused";
        idCalls += 1;
        return id;
      },
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: () => {
        promptCalls += 1;
        return `PROMPT-VERSION-${String(promptCalls)}`;
      },
    });

    const first = core.spawn({ prompt: "one" });
    const second = core.spawn({ prompt: "two" });

    expect(core.getSubagentPrompt(first.subId)).toBe("PROMPT-VERSION-1");
    expect(core.getSubagentPrompt(second.subId)).toBe("PROMPT-VERSION-2");
  });
});
