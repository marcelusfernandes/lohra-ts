#!/usr/bin/env node
// [scheduler-bilateral] evidence class for T18: boots the REAL oracle
// `lohra dashboard` background scheduler and the REAL candidate scheduler
// launcher, both against their own fake upstream, and compares firing
// behavior (assertions 28-35, 43). 6 named scenarios (contract inventory
// 15-20) plus one additional scenario (restart-single-fire, assertion 43)
// beyond the contract's stated minimum.
import { createHash } from "node:crypto";

import { cleanup, localDay, materialize, runCandidateCron, runGuards, runOracleCron, utcDay, writeEvidence } from "./harness.js";
import { readSchedulerLog, startCandidateScheduler, startOracleScheduler, waitFor, type SchedulerProcess } from "./scheduler-harness.js";

let failures = 0;
const projections: { readonly id: string; readonly sha: string; readonly verdict: string }[] = [];

function record(id: string, verdict: string, ok: boolean, payload: unknown): void {
  const sha = writeEvidence(id, { id, verdict, localDay: localDay(), utcDay: utcDay(), ...(payload as object) });
  projections.push({ id, sha, verdict });
  if (!ok) {
    failures += 1;
    process.stderr.write(`T18_SCENARIO_FAILED:${id}\n`);
  }
}

function lastRunAtFromList(stdout: string): boolean {
  // The list line format is `<id>  [state] name  (type=value)` -- it doesn't
  // print last_run_at directly, so "did it fire" is read off the upstream
  // request count; this helper is only used to confirm a job is still
  // listed (alive) after the scheduler stops, not to read the timestamp.
  return stdout.trim().length > 0;
}

async function stopBoth(oracle: SchedulerProcess, candidate: SchedulerProcess): Promise<void> {
  await Promise.all([oracle.stop(), candidate.stop()]);
}

// --- Scenario 15: once already-due fires, once-in-future does not (assertion 32) ----
async function scenario15OnceDueAndFuture(): Promise<void> {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    const due = String(Date.now() / 1000 - 3600);
    const future = String(Date.now() / 1000 + 1_000_000);
    for (const paths of [oracle, candidate]) {
      const run = paths === oracle ? runOracleCron : runCandidateCron;
      run(["add", "--name", "due", "--prompt", "SCEN:ok", "--at", due], paths);
      run(["add", "--name", "future", "--prompt", "SCEN:ok", "--at", future], paths);
    }
    const oracleScheduler = await startOracleScheduler({ paths: oracle });
    const candidateScheduler = await startCandidateScheduler({ paths: candidate });
    await waitFor(() => oracleScheduler.upstream.requests.length >= 1, 8000);
    await waitFor(() => candidateScheduler.upstream.requests.length >= 1, 8000);
    await new Promise((r) => setTimeout(r, 500));
    await stopBoth(oracleScheduler, candidateScheduler);

    const oracleOk = oracleScheduler.upstream.requests.length === 1;
    const candidateOk = candidateScheduler.upstream.requests.length === 1;
    const ok = oracleOk && candidateOk;
    record("t18-once-due-and-future", ok ? "match" : "DIVERGENT", ok, {
      oracleCalls: oracleScheduler.upstream.requests.length,
      candidateCalls: candidateScheduler.upstream.requests.length,
    });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

// --- Scenario 16: interval with last_run_at null fires immediately (assertion 33) ----
async function scenario16IntervalImmediate(): Promise<void> {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    runOracleCron(["add", "--name", "n1", "--prompt", "SCEN:ok", "--interval", "60"], oracle);
    runCandidateCron(["add", "--name", "n1", "--prompt", "SCEN:ok", "--interval", "60"], candidate);
    const oracleScheduler = await startOracleScheduler({ paths: oracle });
    const candidateScheduler = await startCandidateScheduler({ paths: candidate });
    const oracleFired = await waitFor(() => oracleScheduler.upstream.requests.length >= 1, 8000);
    const candidateFired = await waitFor(() => candidateScheduler.upstream.requests.length >= 1, 8000);
    await stopBoth(oracleScheduler, candidateScheduler);
    const ok = oracleFired && candidateFired;
    record("t18-interval-null-fires-immediately", ok ? "match" : "DIVERGENT", ok, {
      oracleFired,
      candidateFired,
      oracleCalls: oracleScheduler.upstream.requests.length,
      candidateCalls: candidateScheduler.upstream.requests.length,
    });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

// --- Scenario 17: disabled job never fires (assertion 34) --------------------
async function scenario17DisabledNeverFires(): Promise<void> {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    const due = String(Date.now() / 1000 - 3600);
    for (const [paths, run] of [
      [oracle, runOracleCron],
      [candidate, runCandidateCron],
    ] as const) {
      const added = run(["add", "--name", "n1", "--prompt", "SCEN:ok", "--at", due], paths);
      const jobId = added.stdout.trim().replace("added job ", "");
      run(["pause", jobId], paths);
    }
    const oracleScheduler = await startOracleScheduler({ paths: oracle });
    const candidateScheduler = await startCandidateScheduler({ paths: candidate });
    await new Promise((r) => setTimeout(r, 2500));
    await stopBoth(oracleScheduler, candidateScheduler);
    const ok = oracleScheduler.upstream.requests.length === 0 && candidateScheduler.upstream.requests.length === 0;
    record("t18-disabled-never-fires", ok ? "match" : "DIVERGENT", ok, {
      oracleCalls: oracleScheduler.upstream.requests.length,
      candidateCalls: candidateScheduler.upstream.requests.length,
    });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

// --- Scenario 18: a run that fails upstream still marks last_run_at (assertion 35) ----
async function scenario18FailedRunStillMarks(): Promise<void> {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    const due = String(Date.now() / 1000 - 3600);
    for (const [paths, run] of [
      [oracle, runOracleCron],
      [candidate, runCandidateCron],
    ] as const) {
      run(["add", "--name", "n1", "--prompt", "SCEN:err418", "--at", due], paths);
    }
    const oracleScheduler = await startOracleScheduler({ paths: oracle });
    const candidateScheduler = await startCandidateScheduler({ paths: candidate });
    await waitFor(() => oracleScheduler.upstream.requests.length >= 1, 8000);
    await waitFor(() => candidateScheduler.upstream.requests.length >= 1, 8000);
    await new Promise((r) => setTimeout(r, 500));
    await stopBoth(oracleScheduler, candidateScheduler);

    const oracleList = runOracleCron(["list"], oracle);
    const candidateList = runCandidateCron(["list"], candidate);
    const oracleMarked = !oracleList.stdout.includes("no scheduled jobs") && lastRunAtFromList(oracleList.stdout);
    const candidateMarked = !candidateList.stdout.includes("no scheduled jobs") && lastRunAtFromList(candidateList.stdout);
    // The real assertion isn't visible from `list`'s text (it never prints
    // last_run_at) -- it's proven by the store file itself still existing
    // and by re-running the scheduler and confirming NO second call despite
    // the first attempt having "failed": a job whose failure caused
    // last_run_at to stay null would fire again immediately on a fresh boot.
    const oracleRetry = await startOracleScheduler({ paths: oracle });
    const candidateRetry = await startCandidateScheduler({ paths: candidate });
    await new Promise((r) => setTimeout(r, 2000));
    await stopBoth(oracleRetry, candidateRetry);
    const oracleNoRetry = oracleRetry.upstream.requests.length === 0;
    const candidateNoRetry = candidateRetry.upstream.requests.length === 0;

    const ok = oracleMarked && candidateMarked && oracleNoRetry && candidateNoRetry;
    record("t18-failed-run-still-marks", ok ? "match" : "DIVERGENT", ok, {
      oracleCalls: oracleScheduler.upstream.requests.length,
      candidateCalls: candidateScheduler.upstream.requests.length,
      oracleNoRetry,
      candidateNoRetry,
    });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

// --- Scenario 19: TZ day boundary, Pacific/Kiritimati vs Etc/GMT+12 (assertions 29-31) ----
function localDayInTZ(tz: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(new Date()));
}

async function scenario19TzDayBoundary(): Promise<void> {
  const dayKiritimati = localDayInTZ("Pacific/Kiritimati");
  const dayBaker = localDayInTZ("Etc/GMT+12");
  const cronExpr = `* * ${String(dayKiritimati)} * *`;

  const oracleKiritimati = materialize("oracle");
  const oracleBaker = materialize("oracle");
  const candidateKiritimati = materialize("candidate");
  const candidateBaker = materialize("candidate");
  try {
    for (const [paths, run] of [
      [oracleKiritimati, runOracleCron],
      [oracleBaker, runOracleCron],
      [candidateKiritimati, runCandidateCron],
      [candidateBaker, runCandidateCron],
    ] as const) {
      run(["add", "--name", "n1", "--prompt", "SCEN:ok", "--cron", cronExpr], paths);
    }
    const oracleK = await startOracleScheduler({ paths: oracleKiritimati, tz: "Pacific/Kiritimati" });
    const oracleB = await startOracleScheduler({ paths: oracleBaker, tz: "Etc/GMT+12" });
    const candidateK = await startCandidateScheduler({ paths: candidateKiritimati, tz: "Pacific/Kiritimati" });
    const candidateB = await startCandidateScheduler({ paths: candidateBaker, tz: "Etc/GMT+12" });

    await waitFor(() => oracleK.upstream.requests.length >= 1, 8000);
    await waitFor(() => candidateK.upstream.requests.length >= 1, 8000);
    await new Promise((r) => setTimeout(r, 1000));
    await Promise.all([oracleK.stop(), oracleB.stop(), candidateK.stop(), candidateB.stop()]);

    // `* * {day} * *` deliberately leaves minute/hour as wildcards (decision
    // 6) -- it fires on every minute-boundary tick that lands within the
    // target day, not exactly once, so ">= 1" is the correct fired-at-all
    // check; only the Baker Island side must observe exactly 0.
    const oracleOk = oracleK.upstream.requests.length >= 1 && oracleB.upstream.requests.length === 0;
    const candidateOk = candidateK.upstream.requests.length >= 1 && candidateB.upstream.requests.length === 0;
    const ok = oracleOk && candidateOk && dayKiritimati !== dayBaker;
    record("t18-tz-day-boundary-kiritimati-baker", ok ? "match" : "DIVERGENT", ok, {
      cronExpr,
      dayKiritimati,
      dayBaker,
      oracleKiritimatiCalls: oracleK.upstream.requests.length,
      oracleBakerCalls: oracleB.upstream.requests.length,
      candidateKiritimatiCalls: candidateK.upstream.requests.length,
      candidateBakerCalls: candidateB.upstream.requests.length,
    });
  } finally {
    cleanup(oracleKiritimati);
    cleanup(oracleBaker);
    cleanup(candidateKiritimati);
    cleanup(candidateBaker);
  }
}

// --- Scenario 20: NaN once job never fires the scheduler (assertion 28) ----
async function scenario20NanNeverFires(): Promise<void> {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    runOracleCron(["add", "--name", "n1", "--prompt", "SCEN:ok", "--at", "nan"], oracle);
    runCandidateCron(["add", "--name", "n1", "--prompt", "SCEN:ok", "--at", "nan"], candidate);
    const oracleScheduler = await startOracleScheduler({ paths: oracle });
    const candidateScheduler = await startCandidateScheduler({ paths: candidate, tickIntervalMs: 300 });
    await new Promise((r) => setTimeout(r, 2500));
    const schedulerLog = readSchedulerLog(candidate.home);
    await stopBoth(oracleScheduler, candidateScheduler);

    const candidateList = runCandidateCron(["list"], candidate);
    const stdoutClean = !candidateList.stdout.includes("Error") && !candidateList.stderr;
    const ok =
      oracleScheduler.upstream.requests.length === 0 &&
      candidateScheduler.upstream.requests.length === 0 &&
      schedulerLog.includes("permanently unreachable") &&
      stdoutClean;
    record("t18-nan-scheduler-never-fires", ok ? "match" : "DIVERGENT", ok, {
      oracleCalls: oracleScheduler.upstream.requests.length,
      candidateCalls: candidateScheduler.upstream.requests.length,
      sinkReceivedDiagnostic: schedulerLog.includes("permanently unreachable"),
      note: "sink check is a candidate-only mechanism probe, never compared to the oracle (decision 7)",
    });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

// --- Additional scenario: a due job fires exactly once across a restart boundary (assertion 43) ----
async function scenarioRestartSingleFire(): Promise<void> {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    const due = String(Date.now() / 1000 - 3600);
    runOracleCron(["add", "--name", "n1", "--prompt", "SCEN:ok", "--at", due], oracle);
    runCandidateCron(["add", "--name", "n1", "--prompt", "SCEN:ok", "--at", due], candidate);

    const oracleFirst = await startOracleScheduler({ paths: oracle });
    const candidateFirst = await startCandidateScheduler({ paths: candidate });
    await waitFor(() => oracleFirst.upstream.requests.length >= 1, 8000);
    await waitFor(() => candidateFirst.upstream.requests.length >= 1, 8000);
    await new Promise((r) => setTimeout(r, 300));
    await stopBoth(oracleFirst, candidateFirst);
    const firstOracleCalls = oracleFirst.upstream.requests.length;
    const firstCandidateCalls = candidateFirst.upstream.requests.length;

    // "Restart": brand-new scheduler processes over the same HOME.
    const oracleSecond = await startOracleScheduler({ paths: oracle });
    const candidateSecond = await startCandidateScheduler({ paths: candidate });
    await new Promise((r) => setTimeout(r, 2000));
    await stopBoth(oracleSecond, candidateSecond);

    const ok =
      firstOracleCalls === 1 &&
      firstCandidateCalls === 1 &&
      oracleSecond.upstream.requests.length === 0 &&
      candidateSecond.upstream.requests.length === 0;
    record("t18-restart-single-fire", ok ? "match" : "DIVERGENT", ok, {
      firstOracleCalls,
      firstCandidateCalls,
      secondOracleCalls: oracleSecond.upstream.requests.length,
      secondCandidateCalls: candidateSecond.upstream.requests.length,
      note: "additional scenario beyond the contract's 6-scenario minimum, closing assertion 43's fire-exactly-once-across-restart claim",
    });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

// --- Scenario 21: masked field `last_run_at` -- markrun mutant refires across a restart the baseline never does (assertion 44, Emenda E5) ----
// Candidate-only: `scenarioRestartSingleFire` above already establishes the
// real bilateral baseline (0 refires on a normal restart, both sides). This
// scenario only needs to show the mutant breaks THAT already-proven
// baseline, so it doesn't re-boot the oracle.
async function scenario21MaskedFieldLastRunAt(): Promise<void> {
  const candidate = materialize("candidate");
  try {
    const due = String(Date.now() / 1000 - 3600);
    runCandidateCron(["add", "--name", "n1", "--prompt", "SCEN:ok", "--at", due], candidate);

    const first = await startCandidateScheduler({ paths: candidate, mutant: "markrun" });
    await waitFor(() => first.upstream.requests.length >= 1, 8000);
    await new Promise((r) => setTimeout(r, 300));
    await first.stop();
    const firstCalls = first.upstream.requests.length;

    const second = await startCandidateScheduler({ paths: candidate, mutant: "markrun" });
    await new Promise((r) => setTimeout(r, 2000));
    await second.stop();
    const secondCalls = second.upstream.requests.length;

    // `markRun` under the mutant reports success without persisting
    // `last_run_at` -- a fresh boot over the same store sees the job as
    // never-run and refires it, unlike the real baseline established by
    // `t18-restart-single-fire` (0 refires, both sides, unmutated).
    const ok = firstCalls >= 1 && secondCalls >= 1;
    record("t18-masked-field-injected-divergence-last-run-at", ok ? "mutant-refires-baseline-does-not" : "DIVERGENT", ok, {
      firstBootCalls: firstCalls,
      secondBootCalls: secondCalls,
      note:
        "candidate-only: the real 0-refire baseline is t18-restart-single-fire's unmutated measurement, " +
        "reused rather than re-measured here. This scenario's own sha, over the raw call counts of both boots, " +
        "is the published projection the field's masked-divergence self-test reacts through.",
    });
  } finally {
    cleanup(candidate);
  }
}

runGuards();
await scenario15OnceDueAndFuture();
await scenario16IntervalImmediate();
await scenario17DisabledNeverFires();
await scenario18FailedRunStillMarks();
await scenario19TzDayBoundary();
await scenario20NanNeverFires();
await scenarioRestartSingleFire();
await scenario21MaskedFieldLastRunAt();

const digestInput = projections
  .toSorted((a, b) => a.id.localeCompare(b.id))
  .map(({ id, sha }) => `${id}=${sha}\n`)
  .join("");
const digest = createHash("sha256").update(digestInput, "utf8").digest("hex");
const result = {
  suite: "t18-cron-scheduler-bilateral",
  scenarios: projections.length,
  failures,
  localDay: localDay(),
  utcDay: utcDay(),
  digest,
  digestFormula: "sha256(sorted UTF-8 lines id=projectionSha256\\n, trailing newline included)",
  projections,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = failures === 0 && projections.length === 8 ? 0 : 1;
