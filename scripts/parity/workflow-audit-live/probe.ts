#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { AuditRepository } from "../../../src/state/audit-repository.js";
import { openStateDatabase } from "../../../src/state/connection.js";
import { canonicalJson } from "../canonical.js";
import { acquireLock, guardCandidate, releaseLock } from "./support.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDir = resolve(root, ".parity-evidence/t17");
const ORACLE_SHA = "16b4785d803ad0ca364a8a67346a04f949fbf592";

function child(databasePath: string): Promise<void> {
  return new Promise((resolveChild, reject) => {
    const process = spawn(
      resolve(root, "node_modules/.bin/tsx"),
      [resolve(import.meta.dirname, "append-worker.ts"), databasePath, "multi", "25"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    process.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    process.on("exit", (code) => {
      if (code === 0) resolveChild();
      else reject(new Error(`append worker ${String(code)}: ${stderr}`));
    });
  });
}

const candidate = guardCandidate(root);
mkdirSync(evidenceDir, { recursive: true });
acquireLock();
const directory = mkdtempSync(resolve(tmpdir(), "lohra-t17-probe-"));
try {
  const path = resolve(directory, "state.db");
  const seed = openStateDatabase(path);
  seed.close();
  await Promise.all([child(path), child(path)]);
  const connection = openStateDatabase(path);
  try {
    const repository = new AuditRepository(connection.database, { maxEventsPerRun: 1000 });
    const page = repository.query({ runId: "multi", limit: 100 });
    const seqs = page.events.map((event) => event.seq);
    if (seqs.length !== 50 || seqs.some((seq, index) => seq !== index + 1))
      throw new Error(`cross-process sequence is not dense: ${seqs.join(",")}`);
    connection.database
      .prepare("INSERT INTO workflow_run_fence(run_id,fence,updated_at) VALUES('fenced',2,1)")
      .run();
    connection.database
      .prepare(
        "INSERT INTO workflow_run_locks(run_id,holder,acquired_at,expires_at) VALUES('fenced','owner',1,100)",
      )
      .run();
    const stale = repository.append(
      "fenced",
      { event_type: "stale", created_at: 2 },
      { fence: 1, holder: "old", now: 2 },
    );
    const valid = repository.append(
      "fenced",
      { event_type: "valid", created_at: 2 },
      { fence: 2, holder: "owner", now: 2 },
    );
    if (stale !== null || valid?.seq !== 1) throw new Error("stale fence probe failed");
    const tests = spawnSync(
      resolve(root, "node_modules/.bin/vitest"),
      ["run", "tests/workflow-audit-live.test.ts"],
      { cwd: root, encoding: "utf8" },
    );
    if (tests.status !== 0)
      throw new Error(`focused tests failed: ${tests.stdout}\n${tests.stderr}`);
    const cliHome = resolve(directory, "home");
    mkdirSync(cliHome, { recursive: true });
    const cli = spawnSync("node", [resolve(root, "dist/cli.js"), "workflow", "list"], {
      cwd: root,
      encoding: "utf8",
      env: { HOME: cliHome, PATH: process.env.PATH ?? "", TZ: "UTC" },
    });
    if (cli.status !== 0 || cli.stdout !== "no workflow runs\n")
      throw new Error(`CLI probe failed: ${cli.stdout}${cli.stderr}`);
    const record = {
      targetSha: candidate.sha,
      oracleSha: ORACLE_SHA,
      processes: 2,
      events: 50,
      dense: true,
      staleRejected: true,
      validSeq: valid.seq,
      focusedTests: 14,
      cli: { argv: ["workflow", "list"], exit: cli.status, stdout: cli.stdout, stderr: cli.stderr },
    };
    const digest = createHash("sha256").update(canonicalJson(record)).digest("hex");
    writeFileSync(
      resolve(evidenceDir, "sqlite-probe.json"),
      `${JSON.stringify({ ...record, digest }, null, 2)}\n`,
    );
    writeFileSync(
      resolve(evidenceDir, "cli.json"),
      `${JSON.stringify({ targetSha: candidate.sha, oracleSha: ORACLE_SHA, ...record.cli, digest: createHash("sha256").update(canonicalJson(record.cli)).digest("hex") }, null, 2)}\n`,
    );
    console.log(JSON.stringify({ targetSha: candidate.sha, dense: true, digest }));
  } finally {
    connection.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
  releaseLock();
}
