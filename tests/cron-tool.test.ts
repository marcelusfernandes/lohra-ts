import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CronStore } from "../src/cron/store.js";
import { CronTool } from "../src/cron/tool.js";

let home: string;
let tool: CronTool;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lohra-cron-tool-"));
  tool = new CronTool(new CronStore(home));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function parse(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>;
}

describe("CronTool.handle — round-trip and envelopes (assertions 39–41)", () => {
  it("add -> list -> pause -> resume -> remove round-trips through handle()", () => {
    const added = parse(
      tool.handle({ action: "add", name: "n1", prompt: "p1", schedule_type: "interval", value: 5 }),
    );
    expect(added.ok).toBe(true);
    expect(typeof added.job_id).toBe("string");
    const jobId = added.job_id as string;

    const listed = parse(tool.handle({ action: "list" }));
    expect(listed.ok).toBe(true);
    const jobs = listed.jobs as readonly Record<string, unknown>[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      id: jobId,
      name: "n1",
      type: "interval",
      value: 5,
      enabled: true,
      last_run_at: null,
    });

    const paused = parse(tool.handle({ action: "pause", job_id: jobId }));
    expect(paused).toEqual({ ok: true, job_id: jobId, action: "pause" });
    const afterPause = parse(tool.handle({ action: "list" }));
    expect((afterPause.jobs as readonly Record<string, unknown>[])[0]?.enabled).toBe(false);

    const resumed = parse(tool.handle({ action: "resume", job_id: jobId }));
    expect(resumed).toEqual({ ok: true, job_id: jobId, action: "resume" });

    const removed = parse(tool.handle({ action: "remove", job_id: jobId }));
    expect(removed).toEqual({ ok: true, job_id: jobId, action: "remove" });
    const afterRemove = parse(tool.handle({ action: "list" }));
    expect(afterRemove.jobs).toEqual([]);
  });

  it("add requires schedule_type", () => {
    const result = parse(tool.handle({ action: "add", name: "n1", prompt: "p1" }));
    expect(result).toEqual({ error: "'add' requires 'schedule_type' (once/interval/cron)" });
  });

  it("CronError from the store surfaces as tool_error(str(exc))", () => {
    const result = parse(
      tool.handle({ action: "add", name: "", prompt: "p1", schedule_type: "interval", value: 5 }),
    );
    expect(result).toEqual({ error: "a job needs a non-empty 'name'" });
  });

  it("unknown action produces the exact oracle message", () => {
    const result = parse(tool.handle({ action: "bogus" }));
    expect(result).toEqual({ error: "unknown action 'bogus' (use add/list/remove/pause/resume)" });
  });

  it("missing job_id on remove/pause/resume produces the exact oracle message", () => {
    for (const action of ["remove", "pause", "resume"] as const) {
      const result = parse(tool.handle({ action }));
      expect(result).toEqual({ error: `'${action}' requires 'job_id'` });
    }
  });

  it("nonexistent job_id produces the exact oracle message with Python repr quoting", () => {
    const result = parse(tool.handle({ action: "remove", job_id: "ghost" }));
    expect(result).toEqual({ error: "no job with id 'ghost'" });
  });
});
