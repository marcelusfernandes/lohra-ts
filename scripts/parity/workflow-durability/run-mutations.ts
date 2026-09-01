#!/usr/bin/env node
// T16 mutation harness — external proof on a TEMPORARY git archive of the
// committed candidate SHA (never the working checkout).
//
// Contract criterion 55 wants two things the shape of this file encodes:
//   * the DIRECT writes (state, cache, node-cost, spend) each prove all three
//     conjuncts of the ownership guard independently. The guard itself is a
//     SINGLE shared primitive (criterion 54 forbids a copy per category), so a
//     conjunct mutant is one edit — what makes the twelve proofs independent is
//     that each one is scored against ONLY that category's planted oracle.
//   * every mutant is a SEMANTIC violation: an edit that leaves valid SQL and
//     valid TypeScript and simply lets a refused write land. A mutant killed by
//     a syntax or arity error proves nothing, so parameter arity is preserved.
//
// Each focus is run GREEN at baseline before it is run under its mutant, so a
// filter that matches no test can never be mistaken for a kill.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalJson } from "../canonical.js";

const root = resolve(process.cwd());

const locks = "src/state/locks.ts";
const repository = "src/state/workflow-repository.ts";
const durability = "src/workflow/durability.ts";
const service = "src/workflow/service.ts";
const sandbox = "src/workflow/sandbox.ts";
const sqliteCache = "src/workflow/sqlite-cache.ts";

const repositoryTests = "tests/state-workflow-repository.test.ts";
const serviceTests = "tests/workflow-service-durability.test.ts";
const durabilityTests = "tests/workflow-durability.test.ts";
const sandboxTests = "tests/workflow-sandbox.test.ts";

interface Edit {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

interface Focus {
  /** The test file the oracle for this mutant lives in. */
  readonly file: string;
  /** vitest -t pattern naming the exact test that must go red. */
  readonly test: string;
}

interface Mutant {
  readonly id: string;
  readonly category: string;
  readonly mechanism: string;
  readonly focus: Focus;
  readonly edits: readonly Edit[];
}

// --- the shared guard's three conjuncts -------------------------------------
// Each rewrite consumes its own bound parameter (`? IS NOT NULL`), so arity is
// unchanged and SQLite is happy: the ONLY thing that changes is that one
// conjunct of live ownership stops being checked.
const CONJUNCTS = [
  { id: "fence", before: "AND f.fence = ?", after: "AND ? IS NOT NULL", what: "exact current fence" },
  { id: "holder", before: "AND l.holder = ?", after: "AND ? IS NOT NULL", what: "current lease holder" },
  { id: "lease-validity", before: "AND l.expires_at > ?", after: "AND ? IS NOT NULL", what: "unexpired lease" },
] as const;

const CATEGORIES = [
  { id: "state", test: "guard state" },
  { id: "cache", test: "guard cache" },
  { id: "node-cost", test: "guard node-cost" },
  { id: "spend", test: "guard spend" },
] as const;

const guardMutants: readonly Mutant[] = CONJUNCTS.flatMap((conjunct) =>
  CATEGORIES.map((category) => ({
    id: `guard-${conjunct.id}-dropped/${category.id}`,
    category: category.id,
    mechanism: `the shared owned-write guard stops checking the ${conjunct.what}; scored against the ${category.id} planted phases`,
    focus: { file: repositoryTests, test: category.test },
    edits: [{ file: repository, before: conjunct.before, after: conjunct.after }],
  })),
);

const combinedMutants: readonly Mutant[] = [
  {
    id: "combined-cell-guard-removed",
    category: "combined",
    mechanism: "the combined cache+cost cell INSERT drops the ownership guard entirely",
    focus: { file: repositoryTests, test: "guard combined" },
    edits: [
      {
        file: repository,
        before: "        .prepare(`${cellSql}${guard.suffix}`)\n        .run(hash, runId, nodeId, outputJson, status, ownership.now, ...guard.params);",
        after: "        .prepare(cellSql)\n        .run(hash, runId, nodeId, outputJson, status, ownership.now);",
      },
    ],
  },
  {
    id: "combined-cost-escapes-refusal",
    category: "combined",
    mechanism: "the cost INSERT runs even when the guarded cell was refused (no longer 'priced or absent')",
    focus: { file: repositoryTests, test: "guard combined" },
    edits: [
      {
        file: repository,
        before: "      if (cell.changes === 0) return false;\n      if (cost !== null) {",
        after: "      const refusedCell = cell.changes === 0;\n      if (cost !== null) {",
      },
      {
        file: repository,
        before: "      }\n      return true;\n    });\n    try {\n      // A refused cell is a refused WRITE",
        after: "      }\n      return !refusedCell;\n    });\n    try {\n      // A refused cell is a refused WRITE",
      },
    ],
  },
];

const namedMutants: readonly Mutant[] = [
  {
    id: "a/acquire-advances-fence-on-loser",
    category: "fence",
    mechanism: "the fence bump leaks outside the winning transaction, so a loser advances it",
    focus: { file: repositoryTests, test: "keeps the fence row alive across releases" },
    edits: [
      {
        file: locks,
        before:
          '          this.database\n            .prepare(\n              "UPDATE workflow_run_fence SET fence = fence + 1, updated_at = ? WHERE run_id = ?",\n            )\n            .run(now, runId);\n          const row = this.database\n            .prepare("SELECT fence FROM workflow_run_fence WHERE run_id = ?")\n            .get(runId) as { readonly fence: bigint };',
        after:
          '          const row = this.database\n            .prepare("SELECT fence FROM workflow_run_fence WHERE run_id = ?")\n            .get(runId) as { readonly fence: bigint };\n          this.database\n            .prepare(\n              "UPDATE workflow_run_fence SET fence = fence + 1, updated_at = ?",\n            )\n            .run(now);',
      },
    ],
  },
  {
    id: "b/release-deletes-fence-row",
    category: "fence",
    mechanism: "release deletes the fence row, so the fence no longer survives a release",
    focus: { file: repositoryTests, test: "keeps the fence row alive across releases" },
    edits: [
      {
        file: locks,
        before:
          '      const result = this.database\n        .prepare("DELETE FROM workflow_run_locks WHERE run_id = ? AND holder = ?")\n        .run(runId, holder);\n      return result.changes > 0;',
        after:
          '      const result = this.database\n        .prepare("DELETE FROM workflow_run_locks WHERE run_id = ? AND holder = ?")\n        .run(runId, holder);\n      this.database.prepare("DELETE FROM workflow_run_fence WHERE run_id = ?").run(runId);\n      return result.changes > 0;',
      },
    ],
  },
  {
    id: "c/heartbeat-renews-after-release",
    category: "heartbeat",
    mechanism: "the heartbeat keeps beating after the lease is gone (immortal timer)",
    focus: { file: durabilityTests, test: "stops at ownership loss" },
    edits: [
      {
        file: durability,
        before: "    if (!held) return; // the lease is somebody else's now; beating on is noise",
        after: "    if (!held) { this.arm(runId); return; }",
      },
    ],
  },
  {
    id: "d/renew-resurrects-expired-lease",
    category: "lease",
    mechanism: "renew drops its validity predicate, so an old holder resurrects an expired lease",
    focus: { file: repositoryTests, test: "renews only the live holder" },
    edits: [
      {
        file: locks,
        before: "           WHERE run_id = ? AND holder = ? AND expires_at > ?",
        after: "           WHERE run_id = ? AND holder = ? AND ? IS NOT NULL",
      },
    ],
  },
  {
    id: "e/autoresume-armed-for-token-budget",
    category: "auto-resume",
    mechanism: "cold start re-arms token_budget_exhausted pauses, which waiting never refills",
    focus: { file: durabilityTests, test: "rearmPendingResumes re-arms only quota-paused" },
    edits: [
      {
        file: durability,
        before: '    for (const row of pausedOn("quota_exhausted")) {',
        after: '    for (const row of [...pausedOn("quota_exhausted"), ...pausedOn("token_budget_exhausted")]) {',
      },
    ],
  },
  {
    id: "f/resume-reexecutes-complete-cell",
    category: "resume",
    mechanism: "the fenced cache reports a miss for cells that already completed, so a resume redoes paid work",
    focus: { file: serviceTests, test: "durable launch defaults to the fenced SQLite node cache" },
    edits: [
      {
        file: sqliteCache,
        before: 'if (cell === undefined) return Object.freeze({ hit: false, output: null, cost: null });',
        after: 'if (cell === undefined || cell.status === "complete") return Object.freeze({ hit: false, output: null, cost: null });',
      },
    ],
  },
  {
    id: "g/spend-seeded-before-acquire",
    category: "launch",
    mechanism: "the budget seed reads the ledger before ownership is proven",
    focus: { file: serviceTests, test: "seeds spend only AFTER acquiring the lease" },
    edits: [
      {
        file: service,
        before: `    const fence = store.locks.acquireRunLease(runId, store.holder, store.ownershipOf().now, store.ttl);
    if (fence === null) {
      const expiry = store.locks.runLeaseExpiry(runId, store.ownershipOf().now);
      return Object.freeze({
        error: busyErrorMessage(runId, expiry, store.ownershipOf().now),
      });
    }
    this.heartbeat?.start(runId);
    const seeded = this.seedSpend(store, runId);`,
        after: `    const seeded = this.seedSpend(store, runId);
    const fence = store.locks.acquireRunLease(runId, store.holder, store.ownershipOf().now, store.ttl);
    if (fence === null) {
      const expiry = store.locks.runLeaseExpiry(runId, store.ownershipOf().now);
      return Object.freeze({
        error: busyErrorMessage(runId, expiry, store.ownershipOf().now),
      });
    }
    this.heartbeat?.start(runId);`,
      },
    ],
  },
  {
    id: "h/sandbox-realpath-removed",
    category: "sandbox",
    mechanism: "fs containment compares raw paths, so a symlink escapes the working root",
    focus: { file: sandboxTests, test: "resolves symlinks via realpath" },
    edits: [
      {
        file: sandbox,
        before: `  const resolvedTarget = realPathOf(target);
  if (resolvedTarget !== target) return inside(resolvedTarget);
  return inside(realPathOf(resolve(target, "..")));`,
        after: `  return inside(target);`,
      },
    ],
  },
  {
    id: "i1/absent-policy-opens-everything",
    category: "sandbox",
    mechanism: "a missing operator policy file grants everything instead of denying by default",
    focus: { file: sandboxTests, test: "default-deny when the operator file is absent" },
    edits: [
      {
        file: sandbox,
        before: "    if (!existsSync(path)) return { fsAllow: [], egressAllow: [] };",
        after: '    if (!existsSync(path)) return { fsAllow: [{ path: "/", writable: true }], egressAllow: ["*"] };',
      },
    ],
  },
  {
    id: "i2/spec-widens-policy",
    category: "sandbox",
    mechanism: "the launched run merges fs_allow/egress_allow out of the SPEC into the operator policy",
    focus: { file: serviceTests, test: "carries the OPERATOR policy, not the spec" },
    edits: [
      {
        file: service,
        before: "    const policy = this.policyLoader?.() ?? DENY_ALL_POLICY;\n    const workingRoot = this.workingRootOf(runId, fence);",
        after: `    const operator = this.policyLoader?.() ?? DENY_ALL_POLICY;
    const declared = parsed.meta as unknown as Record<string, unknown>;
    const policy: SandboxPolicy = {
      fsAllow: [
        ...operator.fsAllow,
        ...(Array.isArray(declared.fs_allow) ? declared.fs_allow : []).map((entry) => ({
          path: String(entry),
          writable: true,
        })),
      ],
      egressAllow: [
        ...operator.egressAllow,
        ...(Array.isArray(declared.egress_allow) ? declared.egress_allow : []).map(String),
      ],
    };
    const workingRoot = this.workingRootOf(runId, fence);`,
      },
    ],
  },
  {
    id: "j/cancel-read-then-write",
    category: "cancel",
    mechanism: "cancel decides busy from a separate read, reopening the window an owner can acquire in",
    focus: { file: serviceTests, test: "cancel busy is decided by the write's own statement" },
    edits: [
      {
        file: service,
        before:
          "    // The BUSY decision rides in the write's own statement (requireUnleased):\n    // no read-before-write window in which an owner could acquire.\n    const written = store.repository.putRunState(runId, {",
        after:
          '    const expiry = store.locks.runLeaseExpiry(runId, store.ownershipOf().now);\n    if (expiry !== null) return Object.freeze({ error: "busy", run_id: runId });\n    const written = store.repository.putRunState(runId, {',
      },
    ],
  },
  {
    id: "l/terminal-ledger-write-after-release",
    category: "terminal",
    mechanism: "the terminal ledger write happens after the lease is released",
    focus: { file: serviceTests, test: "launches under a lease" },
    edits: [
      {
        file: service,
        before:
          "        this.persistSpend(store, runId, effectiveBudget, seeded, engine, stretchOwnership());\n        // A quota pause is the one failure",
        after: "        // A quota pause is the one failure",
      },
      {
        file: service,
        before:
          "        store.locks.releaseRunLease(runId, store.holder);\n        this.stretches.delete(runId);\n        record.settled = true;",
        after:
          "        store.locks.releaseRunLease(runId, store.holder);\n        this.persistSpend(store, runId, effectiveBudget, seeded, engine, stretchOwnership());\n        this.stretches.delete(runId);\n        record.settled = true;",
      },
    ],
  },
  {
    id: "m/refused-terminal-publishes-done",
    category: "terminal",
    mechanism: "a stretch that lost ownership still announces a completed terminal state on the event channel",
    focus: { file: serviceTests, test: "publishes NO done event" },
    edits: [
      {
        file: service,
        before:
          "          // Fail-closed (errata E2): a stretch that lost ownership never",
        after:
          '          this.onEvent?.({ kind: "node", nodeId: parsed.name, state: "complete" });\n          // Fail-closed (errata E2): a stretch that lost ownership never',
      },
    ],
  },
  {
    id: "n/refused-terminal-hangs-the-waiter",
    category: "terminal",
    mechanism: "a stretch that lost ownership never settles its waiter (the bounded promise hangs)",
    focus: { file: serviceTests, test: "runAndWait resolves bounded with the errata envelope" },
    edits: [
      {
        file: service,
        before:
          "          record.resolve(\n            ownershipLost(runId, fence) as unknown as Readonly<Record<string, unknown>>,\n          );",
        after: "          record.settled = false;",
      },
    ],
  },
  {
    id: "o/evicted-run-writes-unfenced",
    category: "fence-memory",
    mechanism: "a run evicted from the bounded fence memory re-reads the live fence and writes anyway",
    focus: { file: serviceTests, test: "evicting a run from the bounded fence memory" },
    edits: [
      {
        file: service,
        before: "      if (token === EVICTED) return null;",
        after:
          "      if (token === EVICTED)\n        return { fence: Number(store.locks.runFenceOf(runId) ?? 0), holder: store.holder, now: store.ownershipOf().now };",
      },
    ],
  },
];

const mutants: readonly Mutant[] = [...guardMutants, ...combinedMutants, ...namedMutants];

function replaceExactlyOnce(source: string, before: string, after: string, id: string): string {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${id}: mutation anchor not found`);
  if (source.indexOf(before, first + before.length) >= 0)
    throw new Error(`${id}: mutation anchor is not unique`);
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

interface RunOutcome {
  readonly exitCode: number | null;
  readonly failedTests: readonly string[];
  readonly ranTests: number;
}

/**
 * Deterministic outcome only: exit code, the names that failed, and how many
 * ran. Raw vitest output carries durations, timestamps and temp paths, which is
 * what made this record's digest move between reproductions.
 */
function runFocus(directory: string, focus: Focus): RunOutcome {
  const result = spawnSync(
    join(directory, "node_modules/.bin/vitest"),
    ["run", focus.file, "-t", focus.test, "--reporter=json", "--outputFile=/dev/stdout"],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  const start = result.stdout.indexOf("{");
  const end = result.stdout.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { exitCode: result.status, failedTests: ["<no json report>"], ranTests: 0 };
  }
  const report = JSON.parse(result.stdout.slice(start, end + 1)) as {
    readonly testResults?: readonly {
      readonly assertionResults?: readonly { readonly status: string; readonly fullName: string }[];
    }[];
  };
  const assertions = (report.testResults ?? []).flatMap(
    (file) => file.assertionResults ?? [],
  );
  const ran = assertions.filter((assertion) => assertion.status !== "pending" && assertion.status !== "skipped");
  return {
    exitCode: result.status,
    failedTests: ran.filter((a) => a.status === "failed").map((a) => a.fullName).sort(),
    ranTests: ran.length,
  };
}

const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.status !== 0 || status.stdout !== "")
  throw new Error("mutation run requires a committed candidate with clean porcelain");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (head.status !== 0) throw new Error("cannot resolve candidate HEAD");
const candidateSha = head.stdout.trim();
const temporary = mkdtempSync(join(tmpdir(), "lohra-t16-mutations-"));

try {
  const archive = spawnSync("git", ["archive", "--format=tar", candidateSha], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new Error("git archive failed");
  const extracted = spawnSync("tar", ["-xf", "-", "-C", temporary], {
    input: archive.stdout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (extracted.status !== 0) throw new Error("tar extraction failed");
  symlinkSync(resolve(root, "node_modules"), join(temporary, "node_modules"), "dir");

  const originals = new Map<string, string>();
  for (const mutant of mutants)
    for (const edit of mutant.edits)
      if (!originals.has(edit.file))
        originals.set(edit.file, readFileSync(join(temporary, edit.file), "utf8"));
  const restoreAll = (): void => {
    for (const [file, original] of originals) writeFileSync(join(temporary, file), original, "utf8");
  };

  // Baseline PER FOCUS: a filter that matches nothing exits nonzero, and would
  // otherwise read as a kill for every mutant pointed at it.
  const baselines = new Map<string, RunOutcome>();
  for (const mutant of mutants) {
    const key = `${mutant.focus.file}::${mutant.focus.test}`;
    if (baselines.has(key)) continue;
    const outcome = runFocus(temporary, mutant.focus);
    if (outcome.exitCode !== 0 || outcome.ranTests === 0) {
      throw new Error(
        `baseline for focus ${key} is not green with tests (exit=${String(outcome.exitCode)}, ran=${String(outcome.ranTests)})`,
      );
    }
    baselines.set(key, outcome);
  }

  const results = mutants.map((mutant) => {
    restoreAll();
    for (const edit of mutant.edits) {
      const path = join(temporary, edit.file);
      writeFileSync(
        path,
        replaceExactlyOnce(readFileSync(path, "utf8"), edit.before, edit.after, mutant.id),
        "utf8",
      );
    }
    const outcome = runFocus(temporary, mutant.focus);
    const key = `${mutant.focus.file}::${mutant.focus.test}`;
    return {
      id: mutant.id,
      category: mutant.category,
      mechanism: mutant.mechanism,
      focus: mutant.focus,
      baselineRanTests: baselines.get(key)?.ranTests ?? 0,
      ranTests: outcome.ranTests,
      killed: outcome.exitCode !== 0 && outcome.failedTests.length > 0,
      killedBy: outcome.failedTests,
      files: mutant.edits.map((edit) => edit.file).sort(),
    };
  });

  restoreAll();
  const restored = [...baselines.keys()].map((key) => {
    const [file, test] = key.split("::");
    const outcome = runFocus(temporary, { file: file as string, test: test as string });
    return { focus: key, green: outcome.exitCode === 0 && outcome.ranTests > 0 };
  });

  const survivors = results.filter((result) => !result.killed).map((result) => result.id);
  const restoreGreen = restored.every((entry) => entry.green);
  const evidence = {
    suite: "t16-workflow-mutations",
    candidateSha,
    copy: "temporary git archive of candidate SHA",
    proof: "baseline green per focus -> mutant red on that focus -> restore green",
    baselines: [...baselines.entries()].map(([focus, outcome]) => ({ focus, ranTests: outcome.ranTests })),
    mutants: results,
    killed: results.length - survivors.length,
    total: results.length,
    byCategory: Object.fromEntries(
      [...new Set(results.map((result) => result.category))]
        .sort()
        .map((category) => [category, results.filter((result) => result.category === category).length]),
    ),
    survivors,
    restore: restored,
    restoreGreen,
  };
  const evidenceDirectory = resolve(root, ".parity-evidence/t16");
  mkdirSync(evidenceDirectory, { recursive: true });
  const evidencePath = resolve(evidenceDirectory, "mutations.json");
  writeFileSync(evidencePath, canonicalJson(evidence), "utf8");
  process.stdout.write(
    `${JSON.stringify({
      suite: evidence.suite,
      candidateSha,
      killed: evidence.killed,
      total: evidence.total,
      byCategory: evidence.byCategory,
      survivors,
      restoreGreen,
      evidence: evidencePath,
    })}\n`,
  );
  process.exitCode = survivors.length === 0 && restoreGreen ? 0 : 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
