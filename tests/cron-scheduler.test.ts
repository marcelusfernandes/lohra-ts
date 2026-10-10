import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSchedulerLoop, tick } from "../src/cron/scheduler.js";
import { CronStore, CronStoreError } from "../src/cron/store.js";
import type { CronJob } from "../src/cron/store.js";

let home: string;
let store: CronStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lohra-cron-scheduler-"));
  store = new CronStore(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

class ManualStop {
  private set = false;

  public isSet(): boolean {
    return this.set;
  }

  public trigger(): void {
    this.set = true;
  }
}

function recorder(calls: string[]): (job: CronJob) => Promise<void> {
  return (job) => {
    calls.push(job.id);
    return Promise.resolve();
  };
}

function alwaysFails(): Promise<void> {
  return Promise.reject(new Error("upstream failed"));
}

describe("tick", () => {
  it("once already due fires once and marks last_run_at", async () => {
    const job = store.add({ name: "n", prompt: "p", type: "once", value: 100 });
    const calls: string[] = [];
    const results = await tick(store, recorder(calls), { now: 100 });
    expect(calls).toEqual([job.id]);
    expect(results).toEqual([{ jobId: job.id, ok: true }]);
    expect(store.get(job.id)?.last_run_at).toBe(100);
  });

  it("once in the future does not fire", async () => {
    const job = store.add({ name: "n", prompt: "p", type: "once", value: 1_000_000 });
    const calls: string[] = [];
    await tick(store, recorder(calls), { now: 100 });
    expect(calls).toEqual([]);
    expect(store.get(job.id)?.last_run_at).toBeNull();
  });

  it("interval with last_run_at null fires immediately, does not wait a full period", async () => {
    const job = store.add({ name: "n", prompt: "p", type: "interval", value: 999 });
    const calls: string[] = [];
    await tick(store, recorder(calls), { now: 1_000 });
    expect(calls).toEqual([job.id]);
  });

  it("disabled job never fires", async () => {
    const job = store.add({ name: "n", prompt: "p", type: "once", value: 100 });
    store.setEnabled(job.id, false);
    const calls: string[] = [];
    await tick(store, recorder(calls), { now: 100 });
    expect(calls).toEqual([]);
    expect(store.get(job.id)?.last_run_at).toBeNull();
  });

  it("a run that fails still marks last_run_at (deliberate, not a bug)", async () => {
    const job = store.add({ name: "n", prompt: "p", type: "once", value: 100 });
    const results = await tick(store, alwaysFails, { now: 100 });
    expect(results).toEqual([{ jobId: job.id, ok: false }]);
    expect(store.get(job.id)?.last_run_at).toBe(100);
  });

  it("persists the claim before invoking the callback and passes the pre-claim snapshot", async () => {
    const job = store.add({ name: "n", prompt: "p", type: "once", value: 100 });
    const seen: Array<{ persisted: number | null; received: number | null }> = [];
    await tick(
      store,
      (snapshot) => {
        seen.push({
          persisted: store.get(job.id)?.last_run_at ?? null,
          received: snapshot.last_run_at,
        });
        return Promise.resolve();
      },
      { now: 100 },
    );
    expect(seen).toEqual([{ persisted: 100, received: null }]);
  });

  it("does not dispatch jobs removed or disabled after the candidate list", async () => {
    const removed = store.add({ name: "removed", prompt: "p", type: "once", value: 100 });
    const disabled = store.add({ name: "disabled", prompt: "p", type: "once", value: 100 });
    const originalList = store.list.bind(store);
    vi.spyOn(store, "list").mockImplementationOnce(() => {
      const stale = originalList();
      store.remove(removed.id);
      store.setEnabled(disabled.id, false);
      return stale;
    });
    const calls: string[] = [];
    expect(await tick(store, recorder(calls), { now: 100 })).toEqual([]);
    expect(calls).toEqual([]);
    expect(store.get(disabled.id)?.last_run_at).toBeNull();
  });

  it("consumes a failed interval and cron occurrence but allows the next window", async () => {
    const interval = store.add({ name: "interval", prompt: "p", type: "interval", value: 5 });
    const cron = store.add({ name: "cron", prompt: "p", type: "cron", value: "* * * * *" });
    const now = new Date(2026, 0, 15, 14, 30, 20).getTime() / 1000;
    expect(await tick(store, alwaysFails, { now })).toEqual([
      { jobId: interval.id, ok: false },
      { jobId: cron.id, ok: false },
    ]);
    expect(await tick(store, recorder([]), { now: now + 20 })).toEqual([]);
    expect(await tick(store, recorder([]), { now: now + 60 })).toEqual([
      { jobId: cron.id, ok: true },
    ]);
    expect(await tick(store, recorder([]), { now: now + 300 })).toEqual([
      { jobId: interval.id, ok: true },
      { jobId: cron.id, ok: true },
    ]);
  });

  it("a NaN-valued once job is never due, tick never calls runJob or marks it", async () => {
    const job = store.add({ name: "n", prompt: "p", type: "once", value: Number.NaN });
    const calls: string[] = [];
    await tick(store, recorder(calls), { now: Number.MAX_SAFE_INTEGER });
    expect(calls).toEqual([]);
    expect(store.get(job.id)?.last_run_at).toBeNull();
  });

  it("assertion 28: a permanently-unreachable NaN job reaches the diagnostics sink, never runJob/stdout", async () => {
    const job = store.add({ name: "n", prompt: "p", type: "once", value: Number.NaN });
    const calls: string[] = [];
    const diagnosed: string[] = [];
    await tick(store, recorder(calls), {
      now: Number.MAX_SAFE_INTEGER,
      diagnostics: (message) => diagnosed.push(message),
    });
    expect(calls).toEqual([]);
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0]).toContain(job.id);
  });

  it("a job that is merely not-due-yet never reaches the diagnostics sink", async () => {
    store.add({ name: "n", prompt: "p", type: "once", value: 1_000_000 });
    const diagnosed: string[] = [];
    await tick(store, recorder([]), {
      now: 100,
      diagnostics: (message) => diagnosed.push(message),
    });
    expect(diagnosed).toEqual([]);
  });
});

describe("runSchedulerLoop", () => {
  it("refuses to start on an invalid store — zero jobs considered (assertion 23)", async () => {
    mkdirSync(join(home, "cron"), { recursive: true });
    writeFileSync(join(home, "cron", "jobs.json"), "{nope");
    const stop = new ManualStop();
    const calls: string[] = [];
    await expect(
      runSchedulerLoop({
        store,
        runJob: recorder(calls),
        stop,
        wait: (): Promise<void> => {
          stop.trigger();
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(CronStoreError);
    expect(calls).toEqual([]);
  });

  it("ticks before the first wait — an already-due job fires within the first pass", async () => {
    const job = store.add({ name: "n", prompt: "p", type: "once", value: 0 });
    const stop = new ManualStop();
    const calls: string[] = [];
    let waited = false;
    await runSchedulerLoop({
      store,
      runJob: recorder(calls),
      stop,
      now: () => 1,
      wait: (): Promise<void> => {
        waited = true;
        stop.trigger();
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([job.id]);
    expect(waited).toBe(true);
  });

  it("a tick-level failure never kills the loop", async () => {
    mkdirSync(join(home, "cron"), { recursive: true });
    writeFileSync(join(home, "cron", "jobs.json"), '{"jobs": []}');
    const stop = new ManualStop();
    let ticks = 0;
    await runSchedulerLoop({
      store,
      runJob: (): Promise<void> => {
        throw new Error("should never be called — no jobs");
      },
      stop,
      wait: (): Promise<void> => {
        ticks += 1;
        if (ticks >= 2) stop.trigger();
        return Promise.resolve();
      },
    });
    expect(ticks).toBe(2);
  });
});
