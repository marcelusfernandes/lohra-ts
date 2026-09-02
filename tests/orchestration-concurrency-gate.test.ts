import { describe, expect, it } from "vitest";

import { ConcurrencyGate } from "../src/orchestration/concurrency-gate.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Drains the microtask queue enough times for a release()-to-next-start
 * chain (resolve -> task settles -> finally releases -> waiter resumes ->
 * next task body runs) to fully unwind. No real timer involved — this is
 * still barrier-forced, not a sleep. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("ConcurrencyGate", () => {
  it("runs up to the limit concurrently, queuing anything beyond it", async () => {
    const gate = new ConcurrencyGate(2);
    const gates = [deferred<undefined>(), deferred<undefined>(), deferred<undefined>()];
    const started: number[] = [];

    const runs = gates.map((barrier, index) =>
      gate.run(async () => {
        started.push(index);
        await barrier.promise;
        return index;
      }),
    );

    // Force the race deterministically: yield the microtask queue so every
    // task that CAN start under the limit has started, before asserting.
    await flushMicrotasks();
    expect(started.sort()).toEqual([0, 1]); // only 2 of 3 started — the limit

    gates[0]?.resolve(undefined);
    await flushMicrotasks();
    expect(started.sort()).toEqual([0, 1, 2]); // releasing a slot admits the third

    gates[1]?.resolve(undefined);
    gates[2]?.resolve(undefined);
    const results = await Promise.all(runs);
    expect(results.sort()).toEqual([0, 1, 2]);
  });

  it("releases the slot even when the task rejects, admitting the next queued task", async () => {
    const gate = new ConcurrencyGate(1);
    const first = deferred<undefined>();
    const started: number[] = [];

    const firstRun = gate
      .run(async () => {
        started.push(0);
        await first.promise;
        throw new Error("boom");
      })
      .catch((error: unknown) => error);

    await flushMicrotasks();
    const secondRun = gate.run(() => {
      started.push(1);
      return Promise.resolve("second-ran");
    });

    expect(started).toEqual([0]); // second is still queued behind the first

    first.resolve(undefined);
    const firstResult = await firstRun;
    expect(firstResult).toBeInstanceOf(Error);

    expect(await secondRun).toBe("second-ran");
    expect(started).toEqual([0, 1]);
  });

  it("runs immediately, with no queueing, when under the limit", async () => {
    const gate = new ConcurrencyGate(4);
    const result = await gate.run(() => Promise.resolve("done"));
    expect(result).toBe("done");
  });
});
