import { describe, expect, it } from "vitest";

import {
  AutoResumeScheduler,
  LeaseHeartbeat,
  MAX_RESUME_ATTEMPTS,
  MAX_RESUME_DELAY,
  MIN_RESUME_DELAY,
  resumeDelay,
} from "../src/workflow/durability.js";
import { LockRepository, openStateDatabase, WorkflowRepository } from "../src/state/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Timer } from "../src/workflow/durability.js";
type TestTimer = Timer & { readonly delay: number; fire(): void; cancelled: boolean };
function timerFactory() {
  const timers: TestTimer[] = [];
  return {
    timers,
    factory: (delay: number, fire: () => void): Timer => {
      const timer: TestTimer = {
        delay,
        fire,
        cancelled: false,
        cancel: () => {
          timer.cancelled = true;
        },
      };
      timers.push(timer);
      return timer;
    },
  };
}

describe("resumeDelay", () => {
  it("pins MIN 60s, MAX 6h, exponential backoff and retry-after precedence", () => {
    expect(MIN_RESUME_DELAY).toBe(60);
    expect(MAX_RESUME_DELAY).toBe(6 * 60 * 60);
    expect(MAX_RESUME_ATTEMPTS).toBe(5);
    expect(resumeDelay(0)).toBe(60);
    expect(resumeDelay(1)).toBe(120);
    expect(resumeDelay(2)).toBe(240);
    expect(resumeDelay(20)).toBe(MAX_RESUME_DELAY);
    expect(resumeDelay(0, 2)).toBe(MIN_RESUME_DELAY);
    expect(resumeDelay(0, 60 * 60 * 24)).toBe(MAX_RESUME_DELAY);
  });
});

describe("LeaseHeartbeat", () => {
  it("beats at TTL/3 and re-arms while ownership holds", () => {
    const { timers, factory } = timerFactory();
    const renewals: string[] = [];
    const heartbeat = new LeaseHeartbeat(
      (runId) => {
        renewals.push(runId);
        return true;
      },
      { interval: 300, timerFactory: factory },
    );
    heartbeat.start("run");
    expect(timers.length).toBe(1);
    expect(timers[0]?.delay).toBe(300);
    timers[0]?.fire();
    expect(renewals).toEqual(["run"]);
    // re-armed after a held renewal: the replacement timer cancels the old one
    const pending = timers.at(-1);
    expect(pending?.cancelled).toBe(false);
    expect(pending?.delay).toBe(300);
  });

  it("stops at ownership loss and never re-arms (zero renew after release)", () => {
    const { timers, factory } = timerFactory();
    let owned = true;
    const heartbeat = new LeaseHeartbeat(() => owned, { interval: 300, timerFactory: factory });
    heartbeat.start("run");
    const first = timers[0];
    if (first === undefined) throw new Error("expected timer");
    first.fire();
    owned = false;
    const pending = timers.filter((timer) => !timer.cancelled).at(-1);
    if (pending === undefined) throw new Error("expected pending timer");
    pending.fire();
    // the renewal returned false: heartbeat stops, no new timer armed
    expect(timers.at(-1)).toBe(pending);
    expect(timers.length).toBe(2); // no third timer was ever armed
  });

  it("stop is authoritative against an in-flight tick (no immortal timer)", () => {
    const { timers, factory } = timerFactory();
    const heartbeat = new LeaseHeartbeat(() => true, { interval: 300, timerFactory: factory });
    heartbeat.start("run");
    heartbeat.stop("run");
    const afterStop = timers.filter((timer) => !timer.cancelled);
    expect(afterStop.length).toBe(0);
    // a racing tick whose timer was already dropped does not resurrect anything
    heartbeat.start("run");
    heartbeat.stop("run");
    heartbeat.start("run");
    heartbeat.shutdown();
    expect(timers.filter((timer) => !timer.cancelled).length).toBe(0);
  });

  it("a tick exception never strands the run (keeps beating)", () => {
    const { timers, factory } = timerFactory();
    const heartbeat = new LeaseHeartbeat(
      () => {
        throw new Error("boom");
      },
      { interval: 300, timerFactory: factory, logError: () => undefined },
    );
    heartbeat.start("run");
    const first = timers[0];
    if (first === undefined) throw new Error("expected timer");
    first.fire();
    // a replacement timer was armed despite the renewal throwing
    expect(timers.at(-1)?.cancelled).toBe(false);
    expect(timers.length).toBe(2);
  });
});

describe("AutoResumeScheduler", () => {
  it("schedules with clamped delay, reports resume_at and caps at 5 attempts", () => {
    const { timers, factory } = timerFactory();
    const resumes: string[] = [];
    const scheduler = new AutoResumeScheduler(
      (runId) => {
        resumes.push(runId);
        return { run_id: runId, status: "started" };
      },
      { timerFactory: factory },
    );
    expect(scheduler.schedule("run", { attempts: 0 })).toBe(60);
    const timer = timers.at(-1);
    if (timer === undefined) throw new Error("expected timer");
    timer.fire();
    expect(resumes).toEqual(["run"]);
    expect(scheduler.schedule("run2", { attempts: 5 })).toBeNull();
  });

  it("cancel and shutdown drop timers; a fired timer claims itself (no resurrection)", () => {
    const { timers, factory } = timerFactory();
    const resumes: string[] = [];
    const scheduler = new AutoResumeScheduler(
      (runId) => {
        resumes.push(runId);
        return { run_id: runId };
      },
      { timerFactory: factory },
    );
    scheduler.schedule("run", { attempts: 0 });
    scheduler.cancel("run");
    const cancelled = timers.at(-1);
    if (cancelled === undefined) throw new Error("expected timer");
    expect(cancelled.cancelled).toBe(true);
    cancelled.fire();
    expect(resumes).toEqual([]);
    // refusal is logged, never swallowed silently
    const refusing = new AutoResumeScheduler(() => ({ error: "no longer paused" }), {
      timerFactory: factory,
      logWarning: (message) => log.push(message),
    });
    const log: string[] = [];
    refusing.schedule("r", { attempts: 0 });
    const fireable = timers.at(-1);
    if (fireable === undefined) throw new Error("expected timer");
    fireable.fire();
    expect(log.join("\n")).toContain("refused");
    expect(log.join("\n")).toContain("no longer paused");
  });

  it("rearmPendingResumes re-arms only quota-paused lines from the durable row", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-durability-"));
    try {
      const connection = openStateDatabase(join(root, "state.db"));
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const fence = locks.acquireRunLease("q-run", "p1", 1000, 60);
      if (fence === null) throw new Error("lease");
      repository.putRunState("q-run", {
        name: "q",
        owner: "p1",
        status: "paused",
        pauseReason: "quota_exhausted",
        pausePayloadJson: JSON.stringify({ attempts: 2 }),
        specJson: null,
        argsJson: "{}",
        tokenBudget: null,
        tainted: false,
        progressJson: null,
        auditSegmentId: null,
        updatedAt: 1000,
        fence,
        holder: "p1",
        now: 1000,
      });
      const fenceB = locks.acquireRunLease("b-run", "p1", 1000, 60);
      if (fenceB === null) throw new Error("lease b");
      repository.putRunState("b-run", {
        name: "b",
        owner: "p1",
        status: "paused",
        pauseReason: "token_budget_exhausted",
        pausePayloadJson: JSON.stringify({ attempts: 0 }),
        specJson: null,
        argsJson: "{}",
        tokenBudget: null,
        tainted: false,
        progressJson: null,
        auditSegmentId: null,
        updatedAt: 1000,
        fence: fenceB,
        holder: "p1",
        now: 1000,
      });
      const { factory } = timerFactory();
      const scheduler = new AutoResumeScheduler(() => ({ run_id: "x", status: "started" }), {
        timerFactory: factory,
      });
      const attemptsOf = (run: string): number => {
        const row = repository.getRunState(run);
        if (row === null) return 0;
        const raw = row.pause_payload_json;
        if (typeof raw !== "string" || raw === "") return 0;
        const payload = JSON.parse(raw) as { attempts?: number };
        return payload.attempts ?? 0;
      };
      const rearmed = scheduler.rearmPendingResumes(
        (reason) =>
          repository.runStatesByPause(reason, 50).map((row) => ({ run_id: String(row.run_id) })),
        attemptsOf,
      );
      expect(rearmed).toEqual(["q-run"]);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
