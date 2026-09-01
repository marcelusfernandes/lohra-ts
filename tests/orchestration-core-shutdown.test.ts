import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OrchestrationCore, type CollectResult } from "../src/orchestration/core.js";

const stubPrompt = (): string => "SUBAGENT_SYSTEM_STUB";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

// Assertion 40/41 (L16): shutdown() drains a real in-flight child (never
// abandons it), interrupts cooperatively via the same AbortSignal machinery
// as Ctrl-C, and logs the cause of any failed/interrupted child through
// logOrchestrationFailure — decision 14/ADR-T13-04's "uncollected failure"
// and assertion 41's "teardown interrupt cause" share this one channel.
describe("OrchestrationCore.shutdown", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lohra-orch-shutdown-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function readLogLines(): readonly Record<string, unknown>[] {
    try {
      const raw = readFileSync(join(home, "logs", "orchestration.log"), "utf8");
      return raw
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  it("aborts every tracked child's signal and does not resolve until its promise settles — drains, never abandons (assertion 40)", async () => {
    const child = deferred<CollectResult>();
    let observedSignal: AbortSignal | undefined;
    const core = new OrchestrationCore({
      runChild: (_subId, _config, _systemPrompt, _drain, signal) => {
        observedSignal = signal;
        return child.promise;
      },
      idSource: () => "aaaa",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    core.spawn({ prompt: "do the thing" });
    await Promise.resolve();

    let settled = false;
    const shutdownPromise = core.shutdown(home).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(observedSignal?.aborted).toBe(true);
    expect(settled).toBe(false);

    child.resolve(okResult({ status: "interrupted", output: "" }));
    await shutdownPromise;
    expect(settled).toBe(true);
  });

  it("logs the cause for a child that settles interrupted during drain", async () => {
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult({ status: "interrupted", output: "" })),
      idSource: () => "bbbb",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    core.spawn({ prompt: "do the thing" });
    await Promise.resolve();
    await core.shutdown(home);

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.["subId"]).toBe("bbbb");
    expect(lines[0]?.["status"]).toBe("interrupted");
  });

  it("logs the cause for a child that settles as an uncollected error during drain (decision 14/ADR-T13-04)", async () => {
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult({ status: "error", output: "boom" })),
      idSource: () => "cccc",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    core.spawn({ prompt: "do the thing" });
    await Promise.resolve();
    await core.shutdown(home);

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.["subId"]).toBe("cccc");
    expect(lines[0]?.["status"]).toBe("error");
  });

  it("logs nothing for a child that completes normally before shutdown is even called", async () => {
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult({ status: "complete", output: "fine" })),
      idSource: () => "dddd",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    core.spawn({ prompt: "do the thing" });
    await Promise.resolve();
    await Promise.resolve();
    await core.shutdown(home);

    expect(readLogLines()).toHaveLength(0);
  });

  it("resolves immediately with an empty registry — never writes the log file when there is nothing to report", async () => {
    const core = new OrchestrationCore({
      runChild: () => Promise.resolve(okResult()),
      idSource: () => "eeee",
      maxSubsessions: 200,
      maxParallel: 200,
      buildSubagentPrompt: stubPrompt,
    });
    await core.shutdown(home);
    expect(readLogLines()).toHaveLength(0);
  });
});
