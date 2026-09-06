// Issue #103: proves the highest-risk hypothesis of the project — a durable
// workflow run survives the process that launched it — in `npm test`
// (`vitest`), not just in the historical `parity:t16` suite that imports
// from `dist/`. Process A launches a durable run and is killed with
// SIGKILL while a second leaf is in flight; the test process then reads the
// same `state.db` through `runWorkflowCommand` (`src/cli.ts:382-400`'s own
// entry point) exactly as an operator's second terminal would, and finally
// a fresh process C resumes the run via `resume_run_id` and proves — by
// counting `runChild` invocations, never by timing — that the already-cached
// cell is not re-executed.
//
// Workers live in `tests/workers/` and are spawned via `tsx`
// (`--import`, `import.meta.resolve("tsx")`), the same mold as
// `tests/parity/stub-driver.test.ts:11-12,66` — this file (and the workers)
// import straight from `src/`, never `dist/`, so the suite proves the
// TypeScript source directly and passes with no build step.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runWorkflowCommand } from "../src/commands/workflow.js";
import { openStateDatabase } from "../src/state/connection.js";
import { RUN_LEASE_TTL } from "../src/workflow/service.js";

const workersDir = resolve(import.meta.dirname, "workers");
const launchWorker = join(workersDir, "workflow-launch-worker.ts");
const resumeWorker = join(workersDir, "workflow-resume-worker.ts");
const tsxLoader = import.meta.resolve("tsx");

// Process A's own clock (injected, never the wall clock — CLAUDE.md
// invariant 4 is about WRITE fencing, but a real clock here would make the
// staleness assertions flaky under CI load). `RUN_LEASE_TTL` is the real
// production value (900s, `locks.ts`); C_NOW sits one second past process
// A's lease expiry so `LockRepository.acquireRunLease` (`locks.ts:80`)
// deletes the dead row before inserting its own — a resume BEFORE that
// point would legitimately be refused (`busyErrorMessage`), which is why
// the "not stale yet" list assertion below uses A_NOW + 1, well inside the
// lease, not C_NOW.
const A_NOW = 1_000;
const C_NOW = A_NOW + RUN_LEASE_TTL + 1;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-t103-cross-process-"));
  roots.push(root);
  return root;
}

async function waitForStdout(
  chunks: Buffer[],
  predicate: (text: string) => boolean,
  describeFailure: () => string,
  timeoutMs = 10_000,
): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    const text = Buffer.concat(chunks).toString("utf8");
    if (predicate(text)) return text;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`WORKER_STDOUT_TIMEOUT: ${describeFailure()}\nstdout so far:\n${text}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface StdoutCall {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(
  options: Omit<Parameters<typeof runWorkflowCommand>[0], "stdout" | "stderr">,
): Promise<StdoutCall> {
  let stdout = "";
  let stderr = "";
  const code = await runWorkflowCommand({
    ...options,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return { code, stdout, stderr };
}

describe("cross-process durability: list/watch/audit/resume see a run across a killed process (issue #103)", () => {
  it("list/watch/audit read a run a killed process left running, and resume avoids re-executing the cached leaf", async () => {
    const root = tmpRoot();
    const databasePath = join(root, "state.db");
    const homeRootA = join(root, "home-a");
    const homeRootC = join(root, "home-c");

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, launchWorker, databasePath, homeRootA, String(A_NOW)],
      { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    // A wrapper object, not a bare `let`, so TypeScript never over-narrows
    // the read in the polling loop below to the literal `null` it starts as
    // (`tests/cli-serve-process.test.ts`'s own `processState` mold, same
    // reason).
    const processState: {
      settled: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
    } = { settled: null };
    child.once("close", (code, signal) => {
      processState.settled = { code, signal };
    });

    try {
      const afterRunId = await waitForStdout(
        stdoutChunks,
        (text) => /RUN_ID /.test(text),
        () => `process A stderr:\n${Buffer.concat(stderrChunks).toString("utf8")}`,
      );
      const runId = /RUN_ID (\S+)/.exec(afterRunId)?.[1];
      expect(runId, afterRunId).toBeTypeOf("string");
      if (runId === undefined) throw new Error("unreachable: asserted above");

      // The signal that node "first" is cached AND node "second"'s leaf
      // is in flight (worker prints it from inside the never-resolving
      // runChild call for "second", after flushing the audit trail —
      // see workflow-launch-worker.ts).
      await waitForStdout(
        stdoutChunks,
        (text) => /READY/.test(text),
        () => `process A stderr:\n${Buffer.concat(stderrChunks).toString("utf8")}`,
      );

      // Kill process A with SIGKILL — no shutdown(), no lease release, no
      // terminal write. This is the crash this whole test exists to
      // survive.
      child.kill("SIGKILL");
      const killedAt = Date.now();
      while (processState.settled === null) {
        if (Date.now() - killedAt > 5_000) throw new Error("PROCESS_A_DID_NOT_EXIT");
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(processState.settled.signal).toBe("SIGKILL");

      // The cached cell survives the process: read it directly, not
      // through any WorkflowService (none is alive here).
      const check = openStateDatabase(databasePath);
      try {
        const cached = check.database
          .prepare("SELECT count(*) AS n FROM workflow_node_cache WHERE run_id = ? AND node_id = ?")
          .get(runId, "first") as { readonly n: number | bigint };
        expect(Number(cached.n)).toBeGreaterThan(0);
      } finally {
        check.close();
      }

      // --- list: a second "terminal" sees the run process A abandoned ---
      const listFresh = await runCommand({
        action: "list",
        databasePath,
        args: {},
        now: () => A_NOW + 1,
      });
      expect(listFresh.code).toBe(0);
      expect(listFresh.stdout).toContain(runId.slice(0, 8));
      expect(listFresh.stdout).toContain("running");
      expect(listFresh.stdout).not.toContain("(stale)");
      // progress_json is persisted after EVERY completed node (issue #125),
      // not only at the terminal write — "first" landed in
      // workflow_node_cache and its progress row before the kill, so a run
      // killed mid-flight (with "second" still in flight) shows 1/2 here,
      // not 0/0.
      expect(listFresh.stdout).toContain("1/2 nodes");

      const listStale = await runCommand({
        action: "list",
        databasePath,
        args: {},
        now: () => C_NOW,
      });
      expect(listStale.stdout).toContain("(stale)");

      // --- watch: injecting `now` past the lease TTL emits the stale hint
      // and returns immediately (no polling needed: the very first check
      // already sees a lease that has expired by `now`'s own clock) ---
      const watched = await runCommand({
        action: "watch",
        databasePath,
        args: { run_id: runId },
        now: () => C_NOW,
        sleep: () => Promise.resolve(),
      });
      expect(watched.code).toBe(0);
      expect(watched.stdout).toContain("(stale)");
      expect(watched.stderr).toContain(
        "the process running this workflow is gone; resume it with run_workflow(resume_run_id=...)",
      );

      // --- audit: events recorded before the kill, and the CLI filters ---
      const auditAll = await runCommand({
        action: "audit",
        databasePath,
        args: { run_id: runId },
      });
      expect(auditAll.code).toBe(0);
      // The public event shape (`audit-model.ts` `publicAuditEvent`) never
      // carries a bare `node_id` — `AuditInput.node_id` becomes
      // `identity.node_path: [nodeId]` (`publicAuditIdentity`).
      const pageAll = JSON.parse(auditAll.stdout) as {
        readonly events: readonly {
          readonly seq: number;
          readonly event_type: string;
          readonly identity: { readonly node_path?: readonly string[] };
        }[];
      };
      expect(pageAll.events.length).toBeGreaterThanOrEqual(3);

      const auditByNode = await runCommand({
        action: "audit",
        databasePath,
        args: { run_id: runId, node_id: "first" },
      });
      const pageByNode = JSON.parse(auditByNode.stdout) as {
        readonly events: readonly {
          readonly identity: { readonly node_path?: readonly string[] };
        }[];
      };
      expect(pageByNode.events.length).toBeGreaterThan(0);
      for (const event of pageByNode.events) expect(event.identity.node_path).toEqual(["first"]);

      const auditByType = await runCommand({
        action: "audit",
        databasePath,
        args: { run_id: runId, event_type: "workflow.plan" },
      });
      const pageByType = JSON.parse(auditByType.stdout) as {
        readonly events: readonly { readonly event_type: string }[];
      };
      expect(pageByType.events).toHaveLength(1);
      expect(pageByType.events[0]?.event_type).toBe("workflow.plan");

      const highestSeq = Math.max(...pageAll.events.map((event) => event.seq));
      const auditAfterSeq = await runCommand({
        action: "audit",
        databasePath,
        args: { run_id: runId, after_seq: highestSeq },
      });
      const pageAfterSeq = JSON.parse(auditAfterSeq.stdout) as {
        readonly events: readonly unknown[];
      };
      expect(pageAfterSeq.events).toHaveLength(0);

      // --- resume: a fresh process, its own runtime, its own spawn
      // counter — the cached cell must not spawn a leaf again ---
      const resumed = spawnSync(
        process.execPath,
        ["--import", tsxLoader, resumeWorker, databasePath, homeRootC, runId, String(C_NOW)],
        { cwd: root, env: process.env, encoding: "utf8", timeout: 15_000 },
      );
      expect(resumed.error, resumed.stderr).toBeUndefined();
      expect(resumed.status, resumed.stderr).toBe(0);
      const resumedOutput = JSON.parse(resumed.stdout.trim().split("\n").at(-1) ?? "{}") as {
        readonly result: { readonly status?: string };
        readonly spawnCounts: Readonly<Record<string, number>>;
      };
      expect(resumedOutput.spawnCounts["produce-first"] ?? 0).toBe(0);
      expect(resumedOutput.spawnCounts["produce-second"]).toBe(1);
      expect(resumedOutput.result.status).toBe("complete");

      // --- after resume: the run is terminal and no longer stale/listed
      // as running; the lease process C held is released on completion ---
      const listAfterResume = await runCommand({
        action: "list",
        databasePath,
        args: {},
        now: () => C_NOW + 1,
      });
      expect(listAfterResume.stdout).toContain("complete");
      expect(listAfterResume.stdout).not.toContain("(stale)");
    } finally {
      if (processState.settled === null) child.kill("SIGKILL");
    }
  }, 30_000);
});
