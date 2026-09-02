#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { AuditRepository } from "../../../src/state/audit-repository.js";
import { openStateDatabase } from "../../../src/state/connection.js";
import type { Ownership } from "../../../src/state/workflow-repository.js";
import { AuditTrail } from "../../../src/workflow/audit-trail.js";
import type { AuditInput } from "../../../src/workflow/audit-model.js";
import { canonicalJson } from "../canonical.js";
import { acquireLock, guardCandidate, releaseLock } from "./support.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDir = resolve(root, ".parity-evidence/t17");
const ORACLE_SHA = "16b4785d803ad0ca364a8a67346a04f949fbf592";

class ControlledRepository extends AuditRepository {
  public attempts = 0;

  public constructor(
    database: ConstructorParameters<typeof AuditRepository>[0],
    private readonly mode: "busy-twice" | "lose-original" | "permanent",
  ) {
    super(database);
  }

  public override append(
    runId: string,
    input: AuditInput,
    ownership?: Ownership,
  ): ReturnType<AuditRepository["append"]> {
    this.attempts += 1;
    if (this.mode === "busy-twice" && this.attempts <= 2) throw new Error("database is busy");
    if (this.mode === "permanent") throw new Error("planted sink failure");
    if (this.mode === "lose-original" && input.event_type !== "audit.gap")
      throw new Error("planted sink failure");
    return super.append(runId, input, ownership);
  }
}

async function probeSinkOutcomes(
  database: ConstructorParameters<typeof AuditRepository>[0],
): Promise<Readonly<Record<string, unknown>>> {
  const busy = new ControlledRepository(database, "busy-twice");
  const busyTrail = new AuditTrail(busy, { retryDelayMs: 0, sleep: () => Promise.resolve() });
  busyTrail.record("busy", { event_type: "node.started", payload: { state: "running" } });
  const busyShutdown = await busyTrail.shutdown(500);
  const busyRows = busy.query({ runId: "busy", limit: 10 }).events;

  const recovered = new ControlledRepository(database, "lose-original");
  const recoveredTrail = new AuditTrail(recovered, {
    retryDelayMs: 0,
    sleep: () => Promise.resolve(),
  });
  recoveredTrail.record("recovered", {
    event_type: "node.started",
    payload: { content: "must-not-return" },
  });
  const recoveredShutdown = await recoveredTrail.shutdown(500);
  const recoveredRows = recovered.query({ runId: "recovered", limit: 10 }).events;

  const warnings: string[] = [];
  const permanent = new ControlledRepository(database, "permanent");
  const permanentTrail = new AuditTrail(permanent, {
    retryDelayMs: 0,
    sleep: () => Promise.resolve(),
    warning: (message) => warnings.push(message),
  });
  permanentTrail.record("permanent", { event_type: "node.started" });
  const permanentShutdown = await permanentTrail.shutdown(100);
  const attemptsAtShutdown = permanent.attempts;
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));

  const recoveredData = recoveredRows[0]?.data;
  const result = Object.freeze({
    busy: Object.freeze({
      attempts: busy.attempts,
      shutdown: busyShutdown,
      rows: busyRows.map((event) => event.event_type),
      gap: busyRows.some((event) => event.event_type === "audit.gap"),
    }),
    recovered: Object.freeze({
      attempts: recovered.attempts,
      shutdown: recoveredShutdown,
      rows: recoveredRows.map((event) => event.event_type),
      reason: recoveredData?.reason,
      dropped_count: recoveredData?.dropped_count,
      originalAbsent: !JSON.stringify(recoveredRows).includes("must-not-return"),
    }),
    permanent: Object.freeze({
      attempts: permanent.attempts,
      attemptsAtShutdown,
      shutdown: permanentShutdown,
      warning: warnings.some((message) => message.includes("failed permanently")),
      lateAttempts: permanent.attempts - attemptsAtShutdown,
    }),
  });
  if (
    !busyShutdown ||
    busy.attempts !== 3 ||
    busyRows.length !== 1 ||
    result.busy.gap ||
    !recoveredShutdown ||
    recoveredRows.length !== 1 ||
    recoveredRows[0]?.event_type !== "audit.gap" ||
    recoveredData?.reason !== "sink_failure" ||
    recoveredData.dropped_count !== 1 ||
    !result.recovered.originalAbsent ||
    permanentShutdown ||
    !result.permanent.warning ||
    result.permanent.lateAttempts !== 0
  )
    throw new Error(`audit sink outcomes failed: ${JSON.stringify(result)}`);
  return result;
}

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
    const sinkOutcomes = await probeSinkOutcomes(connection.database);
    const tests = spawnSync(
      resolve(root, "node_modules/.bin/vitest"),
      ["run", "tests/workflow-audit-live.test.ts"],
      { cwd: root, encoding: "utf8" },
    );
    if (tests.status !== 0)
      throw new Error(`focused tests failed: ${tests.stdout}\n${tests.stderr}`);
    const focusedMatch = /Tests\s+(\d+) passed/.exec(tests.stdout);
    if (focusedMatch?.[1] === undefined) throw new Error("focused test count was not observable");
    const focusedTests = Number.parseInt(focusedMatch[1], 10);
    const cliHome = resolve(directory, "home");
    mkdirSync(cliHome, { recursive: true });
    const cliEnvironment = { HOME: cliHome, PATH: process.env.PATH ?? "", TZ: "UTC" };
    const invokeCli = (argv: readonly string[]) =>
      spawnSync("node", [resolve(root, "dist/cli.js"), ...argv], {
        cwd: root,
        encoding: "utf8",
        env: cliEnvironment,
      });
    const initialTree = readdirSync(cliHome, { recursive: true }).map(String).sort();
    const list = invokeCli(["workflow", "list"]);
    const unknown = invokeCli(["workflow", "audit", "unknown-run"]);
    const treeBefore = readdirSync(cliHome, { recursive: true }).map(String).sort();
    const invalid = invokeCli(["workflow", "run"]);
    const treeAfter = readdirSync(cliHome, { recursive: true }).map(String).sort();
    const unknownBody = JSON.parse(unknown.stdout) as Readonly<Record<string, unknown>>;
    if (
      list.status !== 0 ||
      list.stdout !== "no workflow runs\n" ||
      unknown.status !== 0 ||
      unknownBody.availability !== "unavailable" ||
      invalid.status !== 2 ||
      !invalid.stderr.includes("invalid choice: 'run' (choose from list, watch, audit)") ||
      JSON.stringify(treeBefore) !== JSON.stringify(treeAfter)
    )
      throw new Error(
        `CLI probe failed: ${JSON.stringify({ list, unknown, invalid, treeBefore, treeAfter })}`,
      );
    const cli = Object.freeze({
      environment: Object.freeze({ HOME: "<temporary>", PATH: "inherited", TZ: "UTC" }),
      initialTree,
      treeBefore,
      treeAfter,
      commands: Object.freeze([
        Object.freeze({
          argv: ["workflow", "list"],
          exit: list.status,
          stdout: list.stdout,
          stderr: list.stderr,
        }),
        Object.freeze({
          argv: ["workflow", "audit", "unknown-run"],
          exit: unknown.status,
          stdout: unknown.stdout,
          stderr: unknown.stderr,
        }),
        Object.freeze({
          argv: ["workflow", "run"],
          exit: invalid.status,
          stdout: invalid.stdout,
          stderr: invalid.stderr,
        }),
      ]),
    });
    const record = {
      targetSha: candidate.sha,
      oracleSha: ORACLE_SHA,
      processes: 2,
      events: 50,
      dense: true,
      staleRejected: true,
      validSeq: valid.seq,
      focusedTests,
      sinkOutcomes,
      cli,
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
