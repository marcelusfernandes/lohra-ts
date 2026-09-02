import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CronStore, CronStoreError, readJobs } from "../src/cron/store.js";

let home: string;
let jobsPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lohra-cron-store-"));
  jobsPath = join(home, "cron", "jobs.json");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function plant(kind: string): void {
  const dir = join(home, "cron");
  mkdirSync(dir, { recursive: true });
  if (kind === "absent") return;
  if (kind === "directory") {
    mkdirSync(jobsPath);
    return;
  }
  if (kind === "empty") {
    writeFileSync(jobsPath, "");
    return;
  }
  if (kind === "unreadable") {
    writeFileSync(jobsPath, '{"jobs": []}');
    chmodSync(jobsPath, 0o000);
    return;
  }
  writeFileSync(jobsPath, kind);
}

describe("readJobs — the 16-form fail-closed boundary (Emenda E2/E3)", () => {
  it("absent: legitimate empty state, never throws (Emenda E2)", () => {
    plant("absent");
    expect(readJobs(jobsPath)).toEqual([]);
    expect(existsSync(jobsPath)).toBe(false);
  });

  const structurallyInvalid: Record<string, string> = {
    empty: "",
    invalid_json: "{nope",
    truncated_json: '{"jobs": [{"id": "a"',
    root_list: "[1, 2, 3]",
    root_string: '"hello"',
    root_number: "42",
    root_null: "null",
    jobs_not_list: '{"jobs": {"a": 1}}',
    jobs_missing: '{"other": 1}',
    jobs_null: '{"jobs": null}',
    entry_number: '{"jobs": [42]}',
    entry_empty_object: '{"jobs": [{}]}',
    entry_missing_enabled: '{"jobs": [{"id": "x", "name": "n", "type": "interval", "value": 5}]}',
  };

  for (const [form, content] of Object.entries(structurallyInvalid)) {
    it(`${form}: fail-closed, throws CronStoreError, never destroys bytes`, () => {
      plant(content);
      expect(() => readJobs(jobsPath)).toThrow(CronStoreError);
    });
  }

  it("directory: fail-closed (something at the path, not a usable file)", () => {
    plant("directory");
    expect(() => readJobs(jobsPath)).toThrow(CronStoreError);
  });

  it("unreadable: fail-closed", () => {
    plant("unreadable");
    try {
      expect(() => readJobs(jobsPath)).toThrow(CronStoreError);
    } finally {
      chmodSync(jobsPath, 0o644);
    }
  });

  it("nan_literal: NOT fail-closed — well-formed entry, semantically unreachable value (Emenda E3)", () => {
    plant(
      '{"jobs": [{"id": "x", "name": "n", "prompt": "p", "type": "once", "value": NaN, "enabled": true, "created_at": 0, "last_run_at": null}]}',
    );
    const jobs = readJobs(jobsPath);
    expect(jobs).toHaveLength(1);
    expect(Number.isNaN(jobs[0]?.value)).toBe(true);
  });

  it("CronStoreError never carries file content, only path and a safe cause", () => {
    plant("{nope");
    try {
      readJobs(jobsPath);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CronStoreError);
      const storeError = error as CronStoreError;
      expect(storeError.path).toBe(jobsPath);
      expect(storeError.message).not.toContain("{nope");
      expect(storeError.safeCause).not.toContain("{nope");
    }
  });
});

describe("CronStore — schema, atomicity, and mutation semantics", () => {
  it("add/list/remove round-trip on an empty (absent) store", () => {
    const store = new CronStore(home);
    expect(store.list()).toEqual([]);
    const job = store.add({ name: "n1", prompt: "p1", type: "interval", value: 5 });
    expect(job.enabled).toBe(true);
    expect(job.last_run_at).toBeNull();
    expect(store.list()).toHaveLength(1);
    expect(store.remove(job.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("add validates before touching the store — invalid args never write", () => {
    plant("absent");
    const store = new CronStore(home);
    expect(() => store.add({ name: "", prompt: "p", type: "interval", value: 5 })).toThrow();
    expect(existsSync(jobsPath)).toBe(false);
  });

  it("remove/pause/resume on a nonexistent id return false, never throw", () => {
    const store = new CronStore(home);
    expect(store.remove("nonexistent")).toBe(false);
    expect(store.setEnabled("nonexistent", false)).toBe(false);
  });

  it("pause/resume toggle enabled; markRun sets last_run_at", () => {
    const store = new CronStore(home);
    const job = store.add({ name: "n1", prompt: "p1", type: "once", value: 100 });
    expect(store.setEnabled(job.id, false)).toBe(true);
    expect(store.get(job.id)?.enabled).toBe(false);
    expect(store.setEnabled(job.id, true)).toBe(true);
    expect(store.get(job.id)?.enabled).toBe(true);
    expect(store.markRun(job.id, 12345)).toBe(true);
    expect(store.get(job.id)?.last_run_at).toBe(12345);
  });

  it("writes are atomic: no .tmp file survives a successful add", () => {
    const store = new CronStore(home);
    store.add({ name: "n1", prompt: "p1", type: "interval", value: 5 });
    const entries: string[] = readdirSync(join(home, "cron"));
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(entries).toContain("jobs.json");
  });

  it("round-trips NaN through add -> list without triggering fail-closed (decision 4/assertion 26)", () => {
    const store = new CronStore(home);
    const job = store.add({ name: "n1", prompt: "p1", type: "once", value: Number.NaN });
    expect(Number.isNaN(job.value)).toBe(true);
    const relisted = store.list();
    expect(relisted).toHaveLength(1);
    expect(Number.isNaN(relisted[0]?.value)).toBe(true);
  });

  it("add on a nan_literal-preexisting store preserves the ghost job and appends (Emenda E3, assertion 21c)", () => {
    plant(
      '{"jobs": [{"id": "x", "name": "n", "prompt": "p", "type": "once", "value": NaN, "enabled": true, "created_at": 0, "last_run_at": null}]}',
    );
    const store = new CronStore(home);
    store.add({ name: "n1", prompt: "p1", type: "interval", value: 5 });
    const jobs = store.list();
    expect(jobs).toHaveLength(2);
    expect(jobs.some((job) => job.id === "x" && Number.isNaN(job.value))).toBe(true);
    expect(jobs.some((job) => job.name === "n1")).toBe(true);
  });

  it("add on a genuinely corrupted store (fail-closed) refuses and never destroys bytes", () => {
    plant("{nope");
    const before = readFileSync(jobsPath, "utf8");
    const store = new CronStore(home);
    expect(() => store.add({ name: "n1", prompt: "p1", type: "interval", value: 5 })).toThrow(
      CronStoreError,
    );
    const after = readFileSync(jobsPath, "utf8");
    expect(after).toBe(before);
  });
});
