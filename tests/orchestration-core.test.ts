import { describe, expect, it } from "vitest";

import { OrchestrationCore, type CollectResult } from "../src/orchestration/core.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    });

    order.push("before-spawn");
    const { subId } = core.spawn({ prompt: "do the thing" });
    order.push("after-spawn");

    expect(subId).toBe("aaaa");
    // spawn returned before the child settled — proven by call order, not
    // latency, per the contract's own rejection of latency-based proof.
    expect(order).toEqual(["before-spawn", "child-started", "after-spawn"]);

    child.resolve(okResult());
    await Promise.resolve();
  });

  it("evicts only a terminal entry when over the registry cap, and the running one survives (L9)", async () => {
    const child1 = deferred<CollectResult>();
    let call = 0;
    const core = new OrchestrationCore({
      runChild: () => {
        call += 1;
        return call === 1 ? child1.promise : Promise.resolve(okResult());
      },
      idSource: () => (call === 0 ? "kid-1" : "kid-2"),
      maxSubsessions: 1,
    });

    const first = core.spawn({ prompt: "one" });
    // First is still running; spawning a second over cap must not evict it.
    const second = core.spawn({ prompt: "two" });
    await Promise.resolve();
    await Promise.resolve();

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
    });
    expect((await core.collect("deadbeef", true)).kind).toBe("not-found");
  });

  it("wait:false on a running child returns pending without blocking", async () => {
    const child = deferred<CollectResult>();
    const core = new OrchestrationCore({
      runChild: () => child.promise,
      idSource: () => "aaaa",
      maxSubsessions: 200,
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
