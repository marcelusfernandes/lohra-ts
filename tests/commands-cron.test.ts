import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCron } from "../src/commands/cron.js";

let home: string;
let jobsPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lohra-commands-cron-"));
  jobsPath = join(home, "cron", "jobs.json");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  return runCron({ argv: ["cron", ...argv], home });
}

function plant(content: string): void {
  mkdirSync(join(home, "cron"), { recursive: true });
  writeFileSync(jobsPath, content);
}

describe("runCron — schema, round-trip, restart (assertions 7–9, 42–43)", () => {
  it("list on an empty/absent store: exit 0, 'no scheduled jobs'", () => {
    const result = run(["list"]);
    expect(result).toEqual({ code: 0, stdout: "no scheduled jobs\n", stderr: "" });
  });

  it("add → list → pause → resume → remove round-trips through the real CLI", () => {
    const added = run(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"]);
    expect(added.code).toBe(0);
    expect(added.stdout).toMatch(/^added job [0-9a-f]{32}\n$/u);
    const jobId = added.stdout.trim().replace("added job ", "");

    const listed = run(["list"]);
    expect(listed).toEqual({
      code: 0,
      stdout: `${jobId}  [on] n1  (interval=5)\n`,
      stderr: "",
    });

    expect(run(["pause", jobId])).toEqual({
      code: 0,
      stdout: `pause ${jobId}\n`,
      stderr: "",
    });
    expect(run(["list"]).stdout).toContain("[paused]");

    expect(run(["resume", jobId])).toEqual({
      code: 0,
      stdout: `resume ${jobId}\n`,
      stderr: "",
    });

    expect(run(["remove", jobId])).toEqual({
      code: 0,
      stdout: `remove ${jobId}\n`,
      stderr: "",
    });
    expect(run(["list"]).stdout).toBe("no scheduled jobs\n");
  });

  it("jobs survive a restart — a fresh runCron call against the same home sees them", () => {
    const added = run(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"]);
    const jobId = added.stdout.trim().replace("added job ", "");
    const relisted = runCron({ argv: ["cron", "list"], home });
    expect(relisted.stdout).toContain(jobId);
  });

  it("once value formats as a Python float (always a decimal point)", () => {
    run(["add", "--name", "n1", "--prompt", "p1", "--at", "100"]);
    expect(run(["list"]).stdout).toContain("(once=100.0)");
  });

  it("0 0 * * 7 (Sunday alias) is accepted, no error", () => {
    const result = run(["add", "--name", "n1", "--prompt", "p1", "--cron", "0 0 * * 7"]);
    expect(result.code).toBe(0);
  });
});

describe("runCron — action argument, missing vs. invalid (two distinct argparse error classes)", () => {
  it("no action at all: 'required arguments' class, byte-exact, distinct from invalid choice", () => {
    expect(run([])).toEqual({
      code: 2,
      stdout: "",
      stderr: "lohra cron: error: the following arguments are required: action\n",
    });
  });

  it("an explicitly-provided but unrecognized action (including empty string): 'invalid choice' class", () => {
    expect(run(["frobnicate"]).stderr).toBe(
      "lohra cron: error: argument action: invalid choice: 'frobnicate' (choose from 'list', 'add', 'remove', 'pause', 'resume')\n",
    );
    expect(run([""]).stderr).toBe(
      "lohra cron: error: argument action: invalid choice: '' (choose from 'list', 'add', 'remove', 'pause', 'resume')\n",
    );
  });
});

describe("runCron — validation goldens (byte-exact, decision 12/assertion 10-13)", () => {
  it("add needs one of --interval, --cron, or --at", () => {
    const result = run(["add", "--name", "n1", "--prompt", "p1"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "add needs one of --interval, --cron, or --at\n",
    });
  });

  it("empty name", () => {
    const result = run(["add", "--name", "", "--prompt", "p1", "--interval", "5"]);
    expect(result.stderr).toBe("error: a job needs a non-empty 'name'\n");
    expect(result.code).toBe(2);
  });

  it("empty prompt", () => {
    const result = run(["add", "--name", "n1", "--prompt", "", "--interval", "5"]);
    expect(result.stderr).toBe("error: a job needs a non-empty 'prompt'\n");
  });

  it("interval 0 or negative", () => {
    expect(run(["add", "--name", "n1", "--prompt", "p1", "--interval", "0"]).stderr).toBe(
      "error: 'interval' value must be minutes > 0\n",
    );
  });

  it("cron with 4 fields", () => {
    const result = run(["add", "--name", "n1", "--prompt", "p1", "--cron", "* * * *"]);
    expect(result.stderr).toBe(
      "error: invalid cron expression: cron expression needs 5 fields, got 4: '* * * *'\n",
    );
  });

  it("cron field out of range", () => {
    const result = run(["add", "--name", "n1", "--prompt", "p1", "--cron", "60 * * * *"]);
    expect(result.stderr).toBe(
      "error: invalid cron expression: cron field out of range: '60'\n",
    );
  });

  it("remove needs a job id", () => {
    expect(run(["remove"])).toEqual({ code: 2, stdout: "", stderr: "remove needs a job id\n" });
  });

  it("id inexistente: exit 1, Python-repr quoting", () => {
    expect(run(["remove", "ghost"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "no job with id 'ghost'\n",
    });
  });
});

describe("runCron — the 16-form fail-closed boundary at the CLI layer", () => {
  it("list on a corrupted store: stable nonzero exit, visible error, never crashes", () => {
    plant("{nope");
    const result = run(["list"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  it("add with valid args on a corrupted store refuses and never destroys bytes", () => {
    plant("{nope");
    const before = readFileSync(jobsPath, "utf8");
    const result = run(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"]);
    expect(result.code).toBe(1);
    expect(readFileSync(jobsPath, "utf8")).toBe(before);
  });

  it("add with invalid args on a corrupted store still reports the validation error, not fail-closed", () => {
    plant("{nope");
    const before = readFileSync(jobsPath, "utf8");
    const result = run(["add", "--name", "", "--prompt", "p1", "--interval", "5"]);
    expect(result.stderr).toBe("error: a job needs a non-empty 'name'\n");
    expect(result.code).toBe(2);
    expect(readFileSync(jobsPath, "utf8")).toBe(before);
  });

  it("remove/pause/resume on a corrupted store also fail-closed, never crash uncaught", () => {
    plant("{nope");
    expect(run(["remove", "any-id"]).code).toBe(1);
    expect(run(["pause", "any-id"]).code).toBe(1);
    expect(run(["resume", "any-id"]).code).toBe(1);
  });

  it("nan_literal is NOT fail-closed: list shows the job alive, matching (once=nan)", () => {
    plant(
      '{"jobs": [{"id": "x", "name": "n", "prompt": "p", "type": "once", "value": NaN, "enabled": true, "created_at": 0, "last_run_at": null}]}',
    );
    const result = run(["list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("x  [on] n  (once=nan)\n");
  });
});
