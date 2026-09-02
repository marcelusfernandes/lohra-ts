#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createChatSessionRegistry } from "../../../src/commands/chat.js";
import { AuditRepository } from "../../../src/state/audit-repository.js";
import { openStateDatabase } from "../../../src/state/connection.js";
import type { Ownership } from "../../../src/state/workflow-repository.js";
import { AuditTrail } from "../../../src/workflow/audit-trail.js";
import { safeAuditMetadata, type AuditInput } from "../../../src/workflow/audit-model.js";
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

async function probeRoundOneRegressions(
  database: ConstructorParameters<typeof AuditRepository>[0],
): Promise<Readonly<Record<string, unknown>>> {
  const repository = new AuditRepository(database);
  repository.append("public-audit", { event_type: "node.started", created_at: 1 });
  const registry = createChatSessionRegistry(database, {});
  let publicResult: Readonly<Record<string, unknown>>;
  try {
    publicResult = JSON.parse(
      await registry.dispatch("workflow_audit", { run_id: "public-audit" }),
    ) as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new Error(
      `public audit registry probe failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (publicResult.ok !== true || !Array.isArray(publicResult.events))
    throw new Error("public audit registry probe failed");

  const longRun = `identity-${"r".repeat(200)}`;
  repository.append(longRun, {
    event_type: "node.started",
    segment_id: `segment-${"s".repeat(156)}`,
    node_id: `node-${"n".repeat(104)}`,
    sub_id: `sub-${"u".repeat(156)}`,
    created_at: 2,
  });
  const identityRow = database
    .prepare(
      "SELECT length(run_id) AS run_id,length(segment_id) AS segment_id,length(node_id) AS node_id,length(sub_id) AS sub_id FROM workflow_audit_events WHERE seq=1 AND run_id LIKE 'identity-%'",
    )
    .get() as Readonly<Record<string, bigint>>;
  const identityLengths = Object.fromEntries(
    Object.entries(identityRow).map(([key, value]) => [key, Number(value)]),
  );
  if (
    JSON.stringify(identityLengths) !==
    JSON.stringify({ run_id: 128, segment_id: 128, node_id: 64, sub_id: 128 })
  )
    throw new Error(`bounded identity probe failed: ${JSON.stringify(identityLengths)}`);

  const markerStates = Object.values(
    safeAuditMetadata({
      prompt: { state: "observed" },
      response: { state: "unavailable" },
      reasoning: { state: "redacted" },
      content: { state: "truncated" },
      arguments: { state: "not_observed" },
      result: { state: "not_yet_available" },
    }),
  ).map((value) => (value as Readonly<Record<string, unknown>>).state);
  if (markerStates.some((state) => state !== "excluded_by_policy"))
    throw new Error(`raw marker probe failed: ${JSON.stringify(markerStates)}`);

  repository.append("binary-marker", {
    event_type: "node.completed",
    payload: { result: new Uint8Array(1_000) },
    created_at: 3,
  });
  const binaryStored = JSON.parse(
    String(
      (
        database
          .prepare("SELECT payload_json FROM workflow_audit_events WHERE run_id=?")
          .get("binary-marker") as Readonly<Record<string, unknown>>
      ).payload_json,
    ),
  ) as { readonly data: Readonly<Record<string, unknown>> };
  const binaryReturned = repository.query({ runId: "binary-marker" }).events[0]?.data.result;
  if (
    JSON.stringify(binaryStored.data.result) !==
      JSON.stringify({ state: "excluded_by_policy", bytes: 1_000 }) ||
    JSON.stringify(binaryReturned) !== JSON.stringify(binaryStored.data.result)
  )
    throw new Error(
      `raw marker idempotence probe failed: ${JSON.stringify({ stored: binaryStored.data.result, returned: binaryReturned })}`,
    );

  const sharedRunPrefix = "r".repeat(160);
  const leftRun = `${sharedRunPrefix}-left`;
  const rightRun = `${sharedRunPrefix}-right`;
  repository.append(leftRun, { event_type: "node.started", created_at: 4 });
  repository.append(rightRun, { event_type: "leaf.failed", created_at: 5 });
  const distinctRuns = database
    .prepare("SELECT run_id FROM workflow_audit_state WHERE run_id LIKE 'rrrr%' ORDER BY run_id")
    .all() as readonly { readonly run_id: string }[];
  if (
    distinctRuns.length !== 2 ||
    distinctRuns[0]?.run_id === distinctRuns[1]?.run_id ||
    repository.query({ runId: leftRun }).events[0]?.event_type !== "node.started" ||
    repository.query({ runId: rightRun }).events[0]?.event_type !== "leaf.failed"
  )
    throw new Error(`bounded run identity collision probe failed: ${JSON.stringify(distinctRuns)}`);

  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let first = true;
  const causalOrder: string[] = [];
  const controlled = {
    append: (_runId: string, input: AuditInput) => {
      if (first) {
        first = false;
        throw new Error("database is locked");
      }
      causalOrder.push(input.event_type);
      return {} as never;
    },
    isBusyError: (error: unknown) => error instanceof Error && /locked/.test(error.message),
  } as unknown as AuditRepository;
  const trail = new AuditTrail(controlled, { capacity: 1, retryDelayMs: 0, sleep: () => gate });
  trail.record("causal", { event_type: "node.started" });
  await Promise.resolve();
  trail.record("causal", { event_type: "node.completed" });
  trail.record("causal", { event_type: "node.failed" });
  release();
  if (!(await trail.flush()) || causalOrder.join(",") !== "node.started,node.completed,audit.gap")
    throw new Error(`causal overflow probe failed: ${causalOrder.join(",")}`);

  let releaseEpoch!: () => void;
  const epochGate = new Promise<void>((resolveGate) => {
    releaseEpoch = resolveGate;
  });
  let blockEpoch = true;
  let reenteredEpoch = false;
  const epochOrder: string[] = [];
  let enqueueEpoch = (): void => undefined;
  const epochRepository = {
    append: (_runId: string, input: AuditInput) => {
      if (blockEpoch) {
        blockEpoch = false;
        throw new Error("database is locked");
      }
      epochOrder.push(input.event_type);
      if (input.event_type === "node.completed" && !reenteredEpoch) {
        reenteredEpoch = true;
        enqueueEpoch();
      }
      return {} as never;
    },
    isBusyError: (error: unknown) => error instanceof Error && /locked/.test(error.message),
  } as unknown as AuditRepository;
  const epochTrail = new AuditTrail(epochRepository, {
    capacity: 1,
    retryDelayMs: 0,
    sleep: () => epochGate,
  });
  enqueueEpoch = () => {
    epochTrail.record("epochs", { event_type: "leaf.started" });
    epochTrail.record("epochs", { event_type: "leaf.failed" });
  };
  epochTrail.record("epochs", { event_type: "node.started" });
  await Promise.resolve();
  epochTrail.record("epochs", { event_type: "node.completed" });
  epochTrail.record("epochs", { event_type: "node.failed" });
  releaseEpoch();
  if (
    !(await epochTrail.flush()) ||
    epochOrder.join(",") !== "node.started,node.completed,audit.gap,leaf.started,audit.gap"
  )
    throw new Error(`overflow epochs probe failed: ${epochOrder.join(",")}`);

  return Object.freeze({
    publicRegistry: true,
    identityLengths: Object.freeze(identityLengths),
    markerStates: Object.freeze(markerStates),
    binaryMarker: binaryReturned,
    distinctBoundedRuns: distinctRuns.length,
    causalOrder: Object.freeze(causalOrder),
    epochOrder: Object.freeze(epochOrder),
  });
}

async function probeRoundTwoRegressions(): Promise<Readonly<Record<string, unknown>>> {
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const permanent = {
    append: () => {
      attempts += 1;
      throw new Error("database is locked");
    },
    isBusyError: () => true,
  } as unknown as AuditRepository;
  const shutdownTrail = new AuditTrail(permanent, {
    retryLimit: 6,
    retryDelayMs: 0,
    sleep: () => gate,
  });
  shutdownTrail.record("shutdown", { event_type: "node.started" });
  await Promise.resolve();
  const shutdown = await shutdownTrail.shutdown(1);
  const attemptsAtReturn = attempts;
  release();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  if (shutdown || attempts !== attemptsAtReturn)
    throw new Error(
      `late shutdown attempts probe failed: ${JSON.stringify({ shutdown, attemptsAtReturn, attempts })}`,
    );

  const persisted: {
    runId: string;
    reason: unknown;
    count: number;
    attribution: unknown;
  }[] = [];
  const boundedRepository = {
    append: (runId: string, input: AuditInput) => {
      if (input.event_type === "audit.gap") {
        const payload = safeAuditMetadata(input.payload ?? {});
        persisted.push({
          runId,
          reason: payload.reason,
          count: Number(payload.dropped_count),
          attribution: payload.run_attribution,
        });
      }
      return {} as never;
    },
    isBusyError: () => false,
  } as unknown as AuditRepository;
  const boundedTrail = new AuditTrail(boundedRepository, { capacity: 1 });
  boundedTrail.record("seed", { event_type: "node.started" });
  for (let index = 0; index < 2_000; index += 1)
    boundedTrail.record(`overflow-${String(index)}`, { event_type: "node.started" });
  const boundedInternal = boundedTrail as unknown as {
    readonly dropped: readonly { count: number; reason: string; runId: string }[];
  };
  const peakBuckets = boundedInternal.dropped.length;
  const peakCount = boundedInternal.dropped.reduce((total, marker) => total + marker.count, 0);
  if (!(await boundedTrail.flush())) throw new Error("bounded drop trail did not flush");
  const persistedCount = persisted.reduce((total, marker) => total + marker.count, 0);
  const aggregate = persisted.find(
    (marker) => marker.runId === "$audit" && marker.reason === "drop_bucket_overflow",
  );
  if (
    peakBuckets !== 256 ||
    peakCount !== 2_000 ||
    persistedCount !== 2_000 ||
    aggregate?.attribution !== "unavailable"
  )
    throw new Error(
      `bounded drop buckets probe failed: ${JSON.stringify({ peakBuckets, peakCount, persistedCount, aggregate })}`,
    );

  const corruptReasons: unknown[] = [];
  const corruptRepository = {
    append: (_runId: string, input: AuditInput) => {
      const payload = input.payload as Readonly<Record<string, unknown>> | undefined;
      if (input.event_type === "audit.gap") corruptReasons.push(payload?.reason);
      return {} as never;
    },
    isBusyError: () => false,
  } as unknown as AuditRepository;
  const corruptTrail = new AuditTrail(corruptRepository, { capacity: 1 });
  corruptTrail.record("seed", { event_type: "node.started" });
  const hostile = new Proxy(Object.create(null) as Record<string, unknown>, {
    ownKeys: () => {
      throw new Error("hostile ownKeys");
    },
  });
  corruptTrail.record("corrupt", { event_type: "node.started", payload: hostile });
  if (!(await corruptTrail.flush()) || corruptReasons.join(",") !== "corrupt_payload")
    throw new Error(`corrupt payload cause probe failed: ${JSON.stringify(corruptReasons)}`);

  const privateMarker = { state: "excluded_private_state", fields: 3 };
  const privateProjection = safeAuditMetadata({
    prompt: privateMarker,
    response: privateMarker,
    reasoning: privateMarker,
    content: privateMarker,
    arguments: privateMarker,
    result: privateMarker,
    reasoning_content: privateMarker,
    reasoning_details: privateMarker,
    provider_data: privateMarker,
    encrypted_content: privateMarker,
  });
  const privateStates = Object.fromEntries(
    Object.entries(privateProjection).map(([key, value]) => [
      key,
      (value as Readonly<Record<string, unknown>>).state,
    ]),
  );
  if (
    privateStates.reasoning !== "excluded_private_state" ||
    ["prompt", "response", "content", "arguments", "result"].some(
      (key) => privateStates[key] !== "excluded_by_policy",
    ) ||
    ["reasoning_content", "reasoning_details", "provider_data", "encrypted_content"].some(
      (key) => privateStates[key] !== "excluded_private_state",
    )
  )
    throw new Error(`private marker scope probe failed: ${JSON.stringify(privateStates)}`);

  return Object.freeze({
    shutdown: Object.freeze({ clean: shutdown, attemptsAtReturn, attempts }),
    drops: Object.freeze({ peakBuckets, peakCount, persistedCount, aggregate }),
    corruptReasons: Object.freeze(corruptReasons),
    privateStates: Object.freeze(privateStates),
  });
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

const mutationSha = process.env.LOHRA_T17_MUTATION_ARCHIVE_SHA;
const mutationId = process.env.LOHRA_T17_MUTATION_ID;
const mutationMode = mutationSha !== undefined || mutationId !== undefined;
if (
  mutationMode &&
  (mutationSha === undefined ||
    mutationId === undefined ||
    !/^[0-9a-f]{40}$/u.test(mutationSha) ||
    existsSync(resolve(root, ".git")))
)
  throw new Error("invalid T17 mutation archive invocation");
const candidate = mutationMode ? { sha: mutationSha as string } : guardCandidate(root);
const ownsLock = !mutationMode;
mkdirSync(evidenceDir, { recursive: true });
if (ownsLock) acquireLock();
const directory = mkdtempSync(resolve(tmpdir(), "lohra-t17-probe-"));
try {
  const path = resolve(directory, "state.db");
  const seed = openStateDatabase(path);
  const rollbackRepository = new AuditRepository(seed.database);
  seed.database
    .prepare(
      "CREATE TRIGGER t17_external_rollback BEFORE INSERT ON workflow_audit_events WHEN NEW.run_id='rollback-external' BEGIN SELECT RAISE(ABORT, 'planted rollback'); END",
    )
    .run();
  let rollbackRejected = false;
  try {
    rollbackRepository.append("rollback-external", { event_type: "rejected", created_at: 1 });
  } catch {
    rollbackRejected = true;
  }
  seed.database.prepare("DROP TRIGGER t17_external_rollback").run();
  const afterRollback = rollbackRepository.append("rollback-external", {
    event_type: "accepted",
    created_at: 2,
  });
  seed.close();
  if (!rollbackRejected || afterRollback?.seq !== 1)
    throw new Error("rollback sequence probe failed");
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
      { fence: 1, holder: "owner", now: 2 },
    );
    const valid = repository.append(
      "fenced",
      { event_type: "valid", created_at: 2 },
      { fence: 2, holder: "owner", now: 2 },
    );
    if (stale !== null || valid?.seq !== 1) throw new Error("stale fence probe failed");
    const sinkOutcomes = await probeSinkOutcomes(connection.database);
    const roundOneRegressions = await probeRoundOneRegressions(connection.database);
    const roundTwoRegressions = await probeRoundTwoRegressions();
    let focusedTests = 0;
    if (!mutationMode) {
      const tests = spawnSync(
        resolve(root, "node_modules/.bin/vitest"),
        ["run", "tests/workflow-audit-live.test.ts", "--reporter=json", "--no-color"],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        },
      );
      if (tests.status !== 0)
        throw new Error(`focused tests failed: ${tests.stdout}\n${tests.stderr}`);
      const focusedReport = JSON.parse(tests.stdout) as { readonly numPassedTests?: unknown };
      if (
        typeof focusedReport.numPassedTests !== "number" ||
        !Number.isSafeInteger(focusedReport.numPassedTests)
      )
        throw new Error("focused test count was not observable");
      focusedTests = focusedReport.numPassedTests;
    }
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
      roundOneRegressions,
      roundTwoRegressions,
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
  if (ownsLock) releaseLock();
}
