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

  it("diagnoses a callback failure by job and phase without exposing its message or prompt", async () => {
    const secret = "PROMPT_SECRET_SENTINEL_761";
    const job = store.add({ name: "n", prompt: secret, type: "once", value: 100 });
    const diagnosed: string[] = [];
    const failure = Object.assign(new Error(`provider key=${secret}`), { code: "ETIMEDOUT" });
    const results = await tick(store, () => Promise.reject(failure), {
      now: 100,
      diagnostics: (message) => diagnosed.push(message),
    });
    expect(results).toEqual([{ jobId: job.id, ok: false }]);
    expect(store.get(job.id)?.last_run_at).toBe(100);
    expect(diagnosed).toEqual([`cron job ${job.id} phase=callback cause=ETIMEDOUT`]);
    expect(diagnosed.join(" ")).not.toContain(secret);
  });

  it("reports an uncoded callback failure when diagnostics is omitted and does not retry once", async () => {
    const secret = "UNCODED_SECRET_SENTINEL_761";
    const job = store.add({ name: "n", prompt: secret, type: "once", value: 100 });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await tick(store, () => Promise.reject(new Error(secret)), { now: 100 })).toEqual([
        { jobId: job.id, ok: false },
      ]);
      expect(warning).toHaveBeenCalledWith(`cron job ${job.id} phase=callback cause=Error`);
      expect(warning.mock.calls.flat().join(" ")).not.toContain(secret);
      expect(await tick(store, recorder([]), { now: 100 })).toEqual([]);
    } finally {
      warning.mockRestore();
    }
  });

  it("names a failed claim with its job id, then propagates the store error", async () => {
    const secret = "STORE_SECRET_SENTINEL_761";
    const job = store.add({ name: "n", prompt: secret, type: "once", value: 100 });
    const diagnosed: string[] = [];
    const failure = Object.assign(new Error(secret), { code: "EIO" });
    vi.spyOn(store, "tryClaimDue").mockImplementationOnce(() => {
      throw failure;
    });
    await expect(
      tick(store, recorder([]), { now: 100, diagnostics: (message) => diagnosed.push(message) }),
    ).rejects.toBe(failure);
    expect(diagnosed).toEqual([`cron job ${job.id} phase=claim cause=EIO`]);
    expect(diagnosed.join(" ")).not.toContain(secret);
    expect(store.get(job.id)?.last_run_at).toBeNull();
  });

  it("does not swallow a failed diagnostics sink after a callback failure", async () => {
    const job = store.add({ name: "n", prompt: "p", type: "once", value: 100 });
    const sinkFailure = new Error("diagnostics sink unavailable");
    await expect(
      tick(store, alwaysFails, {
        now: 100,
        diagnostics: () => {
          throw sinkFailure;
        },
      }),
    ).rejects.toBe(sinkFailure);
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

  it("reports a store failure with safe cause and continues for a bounded next tick", async () => {
    const secret = "STORE_LOOP_SECRET_SENTINEL_761";
    const stop = new ManualStop();
    const diagnosed: string[] = [];
    const list = store.list.bind(store);
    let calls = 0;
    vi.spyOn(store, "list").mockImplementation(() => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error(secret), { code: "EACCES" });
      return list();
    });
    let waits = 0;
    await runSchedulerLoop({
      store,
      runJob: recorder([]),
      stop,
      now: () => 100,
      wait: () => {
        waits += 1;
        if (waits === 2) stop.trigger();
        return Promise.resolve();
      },
      diagnostics: (message) => diagnosed.push(message),
    });
    expect(calls).toBe(3);
    expect(waits).toBe(2);
    expect(diagnosed).toEqual(["cron scheduler phase=tick cause=EACCES"]);
    expect(diagnosed.join(" ")).not.toContain(secret);
  });

  it("uses the default warning sink when loop diagnostics is omitted", async () => {
    const stop = new ManualStop();
    const list = store.list.bind(store);
    let calls = 0;
    vi.spyOn(store, "list").mockImplementation(() => {
      calls += 1;
      if (calls === 2) throw new Error("PRIVATE_LOOP_MESSAGE_761");
      return list();
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runSchedulerLoop({
        store,
        runJob: recorder([]),
        stop,
        wait: () => {
          stop.trigger();
          return Promise.resolve();
        },
      });
      expect(warning).toHaveBeenCalledWith("cron scheduler phase=tick cause=Error");
      expect(warning.mock.calls.flat().join(" ")).not.toContain("PRIVATE_LOOP_MESSAGE_761");
    } finally {
      warning.mockRestore();
    }
  });

  it("reports a fixed CronStoreError cause without disclosing its path", async () => {
    const stop = new ManualStop();
    const list = store.list.bind(store);
    let calls = 0;
    vi.spyOn(store, "list").mockImplementation(() => {
      calls += 1;
      if (calls === 2) {
        throw new CronStoreError("PRIVATE_STORE_PATH_761", "content is not valid JSON");
      }
      return list();
    });
    const diagnosed: string[] = [];
    await runSchedulerLoop({
      store,
      runJob: recorder([]),
      stop,
      wait: () => {
        stop.trigger();
        return Promise.resolve();
      },
      diagnostics: (message) => diagnosed.push(message),
    });
    expect(diagnosed).toEqual(["cron scheduler phase=tick cause=cron_store_invalid_json"]);
    expect(diagnosed.join(" ")).not.toContain("PRIVATE_STORE_PATH_761");
  });
});
