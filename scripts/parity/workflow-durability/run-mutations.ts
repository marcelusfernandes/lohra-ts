#!/usr/bin/env node
// T16 mutation harness — external proof: baseline green → each mutant red →
// restore green, on a TEMPORARY git archive of the committed candidate SHA
// (never the working checkout). Contract criterion 55 (a)–(o).
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
const focalTests = [
  "tests/state-workflow-repository.test.ts",
  "tests/workflow-durability.test.ts",
  "tests/workflow-service-durability.test.ts",
  "tests/workflow-sandbox.test.ts",
  "tests/state-locks.test.ts",
] as const;

interface Edit {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

interface Mutant {
  readonly id: string;
  readonly mechanism: string;
  readonly edits: readonly Edit[];
}

const locks = "src/state/locks.ts";
const repository = "src/state/workflow-repository.ts";
const durability = "src/workflow/durability.ts";
const service = "src/workflow/service.ts";
const sandbox = "src/workflow/sandbox.ts";

const mutants: readonly Mutant[] = [
  {
    id: "state-fence-guard-removed",
    mechanism: "owned state write skips the ownership guard entirely",
    edits: [{ file: repository,
      before: "    const guarded = `${sql}\n       FROM (SELECT 1 AS dual)\n       JOIN workflow_run_fence f ON f.run_id = ? AND f.fence = ?\n       JOIN workflow_run_locks l ON l.run_id = ? AND l.holder = ?\n         AND l.expires_at > ?`;",
      after: "    const guarded = `${sql}`;" }],
  },
  {
    id: "acquire-advances-fence-on-loser",
    mechanism: "fence bump leaks outside the winning transaction (loser advances it)",
    edits: [{ file: locks,
      before: "          this.database\n            .prepare(\n              \"UPDATE workflow_run_fence SET fence = fence + 1, updated_at = ? WHERE run_id = ?\",\n            )\n            .run(now, runId);\n          const row = this.database\n            .prepare(\"SELECT fence FROM workflow_run_fence WHERE run_id = ?\")\n            .get(runId) as { readonly fence: bigint };",
      after: "          const row = this.database\n            .prepare(\"SELECT fence FROM workflow_run_fence WHERE run_id = ?\")\n            .get(runId) as { readonly fence: bigint };\n          this.database\n            .prepare(\n              \"UPDATE workflow_run_fence SET fence = fence + 1, updated_at = ?\",\n            )\n            .run(now);" }],
  },
  {
    id: "release-deletes-fence-row",
    mechanism: "release deletes the fence row (fence no longer survives release)",
    edits: [{ file: locks, before: `      const result = this.database
        .prepare("DELETE FROM workflow_run_locks WHERE run_id = ? AND holder = ?")
        .run(runId, holder);
      return result.changes > 0;`, after: `      const result = this.database
        .prepare("DELETE FROM workflow_run_locks WHERE run_id = ? AND holder = ?")
        .run(runId, holder);
      this.database.prepare("DELETE FROM workflow_run_fence WHERE run_id = ?").run(runId);
      return result.changes > 0;` }],
  },
  {
    id: "heartbeat-renews-after-release",
    mechanism: "heartbeat keeps renewing after the lease is gone (immortal timer)",
    edits: [{ file: durability, before: `    if (!held) return; // the lease is somebody else's now; beating on is noise`,
      after: `    if (!held) { this.arm(runId); return; }` }],
  },
  {
    id: "renew-resurrects-expired-lease",
    mechanism: "renew drops the expires_at predicate (old holder resurrects the lease)",
    edits: [{ file: locks, before: `           WHERE run_id = ? AND holder = ? AND expires_at > ?`,
      after: `           WHERE run_id = ? AND holder = ?` }],
  },
  {
    id: "autoresume-armed-for-token-budget",
    mechanism: "cold-start re-arms token_budget_exhausted pauses (never refills)",
    edits: [{ file: durability, before: `    for (const row of pausedOn("quota_exhausted")) {`,
      after: `    for (const row of [...pausedOn("quota_exhausted"), ...pausedOn("token_budget_exhausted")]) {` }],
  },
  {
    id: "spend-seeded-before-acquire",
    mechanism: "budget seed reads the ledger before ownership is proven",
    edits: [{ file: service, before: `    const fence = store.locks.acquireRunLease(runId, store.holder, store.ownershipOf().now, store.ttl);
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
    this.heartbeat?.start(runId);` }],
  },
  {
    id: "sandbox-realpath-removed",
    mechanism: "fs containment compares raw paths (symlink escape passes)",
    edits: [{ file: sandbox, before: `  const resolvedTarget = realPathOf(target);
  if (resolvedTarget !== target) return inside(resolvedTarget);
  return inside(realPathOf(resolve(target, "..")));`,
      after: `  return inside(target);` }],
  },
  {
    id: "spec-widens-policy",
    mechanism: "spec-supplied fs_allow widens the operator capability",
    edits: [{ file: sandbox,
      before: "    if (!existsSync(path)) return { fsAllow: [], egressAllow: [] };",
      after: "    if (!existsSync(path)) return { fsAllow: [{ path: \"/\", writable: true }], egressAllow: [\"*\"] };" }],
  },
  {
    id: "terminal-write-after-release",
    mechanism: "terminal line is persisted after the lease is released",
    edits: [{ file: service,
      before: "        this.persistSpend(store, runId, effectiveBudget, seeded, engine, stretchOwnership);\n        // The heartbeat stops FIRST; a tick that outlived the release would put\n        // the lease back and leave the run looking alive with nobody in it.\n        this.heartbeat?.stop(runId);",
      after: "        this.persistSpend(store, runId, effectiveBudget, seeded, engine, stretchOwnership);\n        // The heartbeat stops FIRST; a tick that outlived the release would put\n        // the lease back and leave the run looking alive with nobody in it.\n        store.locks.releaseRunLease(runId, store.holder);\n        this.heartbeat?.stop(runId);" }],
  },
  {
    id: "ownership-lost-publishes-success",
    mechanism: "a lost-ownership stretch resolves the waiter with success",
    edits: [{ file: service, before: `          record.resolve(
            ownershipLost(runId, stretchOwnership.fence) as unknown as Readonly<Record<string, unknown>>,
          );`,
      after: `          record.resolve(resultView(runId, parsed.name, result, engine.budget));` }],
  },
];

function replaceExactlyOnce(source, before, after, id) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${id}: mutation anchor not found`);
  if (source.indexOf(before, first + before.length) >= 0)
    throw new Error(`${id}: mutation anchor is not unique`);
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function runTests(directory) {
  const result = spawnSync(join(directory, "node_modules/.bin/vitest"), ["run", ...focalTests], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return {
    exitCode: result.status,
    stdoutTail: result.stdout.slice(-4_000),
    stderrTail: result.stderr.slice(-4_000),
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

  const originals = new Map();
  for (const mutant of mutants)
    for (const edit of mutant.edits)
      if (!originals.has(edit.file))
        originals.set(edit.file, readFileSync(join(temporary, edit.file), "utf8"));

  const baseline = runTests(temporary);
  if (baseline.exitCode !== 0) throw new Error("mutation baseline is not green");
  const results = [];
  for (const mutant of mutants) {
    for (const [file, original] of originals) writeFileSync(join(temporary, file), original, "utf8");
    for (const edit of mutant.edits) {
      const path = join(temporary, edit.file);
      const source = readFileSync(path, "utf8");
      writeFileSync(path, replaceExactlyOnce(source, edit.before, edit.after, mutant.id), "utf8");
    }
    const result = runTests(temporary);
    results.push({
      id: mutant.id,
      mechanism: mutant.mechanism,
      killed: result.exitCode !== 0,
      ...result,
    });
  }
  for (const [file, original] of originals) writeFileSync(join(temporary, file), original, "utf8");
  const restored = runTests(temporary);
  const survivors = results.filter((result) => !result.killed).map((result) => result.id);
  const evidence = {
    suite: "t16-workflow-mutations",
    candidateSha,
    copy: "temporary git archive of candidate SHA",
    baselineGreen: true,
    mutants: results,
    killed: results.length - survivors.length,
    total: results.length,
    survivors,
    restoreGreen: restored.exitCode === 0,
  };
  const evidenceDirectory = resolve(root, ".parity-evidence/t16");
  mkdirSync(evidenceDirectory, { recursive: true });
  const evidencePath = resolve(evidenceDirectory, "mutations.json");
  writeFileSync(evidencePath, canonicalJson(evidence), "utf8");
  process.stdout.write(
    `${JSON.stringify({ suite: evidence.suite, candidateSha, killed: evidence.killed, total: evidence.total, survivors, restoreGreen: evidence.restoreGreen, evidence: evidencePath })}\n`,
  );
  process.exitCode = survivors.length === 0 && restored.exitCode === 0 ? 0 : 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
