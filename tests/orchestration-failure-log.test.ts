import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { logOrchestrationFailure } from "../src/orchestration/failure-log.js";

// Mirrors the T12 gateway lane's failure-log shape (ADR-T12-02/ADR-T13-07):
// a JSON-line file under <home>/logs/, never stdout/stderr, home passed in
// explicitly so the write stays hermetic to whatever LOHRA_HOME the caller
// resolved — never re-resolved here.
describe("logOrchestrationFailure", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lohra-orch-failure-log-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function readLines(): readonly Record<string, unknown>[] {
    const raw = readFileSync(join(home, "logs", "orchestration.log"), "utf8");
    return raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("creates <home>/logs/orchestration.log and appends one JSON line per call", () => {
    logOrchestrationFailure(home, { kind: "teardown-interrupt", subId: "abc" });
    logOrchestrationFailure(home, { kind: "uncollected-failure", subId: "def" });
    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.["kind"]).toBe("teardown-interrupt");
    expect(lines[0]?.["subId"]).toBe("abc");
    expect(lines[1]?.["kind"]).toBe("uncollected-failure");
    expect(lines[1]?.["subId"]).toBe("def");
  });

  it("stamps every entry with an 'at' timestamp in seconds, not overridable by the entry", () => {
    const before = Date.now() / 1000;
    logOrchestrationFailure(home, { at: "should not survive", kind: "x" });
    const after = Date.now() / 1000;
    const [line] = readLines();
    expect(typeof line?.["at"]).toBe("number");
    expect(line?.["at"] as number).toBeGreaterThanOrEqual(before);
    expect(line?.["at"] as number).toBeLessThanOrEqual(after);
  });

  it("never writes to stdout or stderr", () => {
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    let stdoutCalls = 0;
    let stderrCalls = 0;
    process.stdout.write = ((...args: Parameters<typeof stdoutWrite>) => {
      stdoutCalls += 1;
      return stdoutWrite(...args);
    }) as typeof process.stdout.write;
    process.stderr.write = ((...args: Parameters<typeof stderrWrite>) => {
      stderrCalls += 1;
      return stderrWrite(...args);
    }) as typeof process.stderr.write;
    try {
      logOrchestrationFailure(home, { kind: "silent" });
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }
    expect(stdoutCalls).toBe(0);
    expect(stderrCalls).toBe(0);
  });
});
