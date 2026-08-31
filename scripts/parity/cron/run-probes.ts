#!/usr/bin/env node
// [oracle-only] + [processo-ts] + [probe-complementar] evidence classes for
// T18: R7's tick() non-dict-abort probe, concurrent-add-no-lost-update,
// candidate-scheduler-startup-refusal over the 16 fail-closed forms, and the
// masked-field + fail-closed-guard mutation-kill self-tests (assertions 24,
// 36-38, 44).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ADD_DESTROYS_11, ADD_PRESERVES_AND_APPENDS_4, FAIL_CLOSED_16, plantForm } from "./forms.js";
import {
  candidateCli,
  cleanup,
  jobsPathOf,
  localDay,
  materialize,
  runCandidateCron,
  runCandidateCronMutant,
  runGuards,
  runOracleCron,
  utcDay,
  writeEvidence,
  type RuntimePaths,
} from "./harness.js";
import { startOracleScheduler, startCandidateScheduler, waitFor } from "./scheduler-harness.js";

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

// --- R7 oracle-only: does a non-dict entry abort the whole tick? (assertion 36) ----
async function probeR7TickNonDictAbort(): Promise<void> {
  const oracle = materialize("oracle");
  try {
    const due = String(Date.now() / 1000 - 3600);
    runOracleCron(["add", "--name", "valid", "--prompt", "SCEN:ok", "--at", due], oracle);
    const path = jobsPathOf(oracle);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { jobs: unknown[] };
    parsed.jobs = [42, ...parsed.jobs];
    writeFileSync(path, JSON.stringify(parsed), "utf8");

    const oracleScheduler = await startOracleScheduler({ paths: oracle });
    await new Promise((r) => setTimeout(r, 2500));
    await oracleScheduler.stop();

    const wholeTickAborted = oracleScheduler.upstream.requests.length === 0;
    record("t18-tick-nondict-entry-abort-probe", "oracle-only", true, {
      note: "[oracle-only] -- never compared to the candidate, which structurally cannot reach this state under the ADR (decision 9)",
      upstreamCalls: oracleScheduler.upstream.requests.length,
      wholeTickAborted,
      finding: wholeTickAborted
        ? "the whole tick aborted -- the valid job alongside the non-dict entry also never fired, confirming R7"
        : "only the bad entry was skipped -- the valid job still fired despite the non-dict entry (contradicts R7 as understood)",
    });
  } finally {
    cleanup(oracle);
  }
}

// --- processo-ts: N concurrent candidate `add` processes, no lost update (assertion 37) ----
function spawnCandidateAdd(paths: RuntimePaths, index: number): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(
      process.execPath,
      [candidateCli, "cron", "add", "--name", `n${String(index)}`, "--prompt", "p", "--interval", "5"],
      { cwd: paths.tmp, env: { HOME: paths.home, LOHRA_HOME: paths.home, TMPDIR: paths.tmp, PATH: "/usr/bin:/bin" } },
    );
    child.once("exit", (code) => {
      resolveExit(code ?? -1);
    });
  });
}

async function probeConcurrentAddNoLostUpdate(): Promise<void> {
  const candidate = materialize("candidate");
  try {
    const N = 12;
    const exitCodes = await Promise.all(Array.from({ length: N }, (_, i) => spawnCandidateAdd(candidate, i)));
    const listed = runCandidateCron(["list"], candidate);
    const jobCount = listed.stdout.split("\n").filter(Boolean).length;
    const lockDir = jobsPathOf(candidate) + ".lock";
    const staleTmpFiles = readdirSync(join(candidate.home, "cron")).filter((name) => name.endsWith(".tmp"));
    const allExited0 = exitCodes.every((code) => code === 0);
    const ok = allExited0 && jobCount === N && !existsSync(lockDir) && staleTmpFiles.length === 0;
    record("t18-concurrent-add-no-lost-update", ok ? "as-expected" : "DIVERGENT", ok, {
      note: "[processo-ts] -- unilateral candidate evidence, no oracle-side race claim (decision 5)",
      requested: N,
      jobCount,
      allExited0,
      lockDirLeftBehind: existsSync(lockDir),
      staleTmpFiles,
    });
  } finally {
    cleanup(candidate);
  }
}

// --- processo-ts: candidate scheduler startup refusal over 16 fail-closed forms (assertion 23) ----
async function probeSchedulerStartupRefusal(): Promise<void> {
  let ok = true;
  const results: unknown[] = [];
  for (const form of FAIL_CLOSED_16) {
    const candidate = materialize("candidate");
    try {
      plantForm(form, candidate);
      const scheduler = await startCandidateScheduler({ paths: candidate });
      await new Promise((r) => setTimeout(r, 1500));
      const exit = scheduler.exitInfo();
      await scheduler.stop();
      // "Refuses to start" means the process EXITS non-zero before ticking
      // -- `runSchedulerLoop`'s top-level `store.list()` rejection propagates
      // as an unhandled rejection, so a real refusal is observable as both
      // "exited" and "code !== 0", not merely "never ticked yet".
      const refused = exit.exited && exit.code !== 0 && scheduler.upstream.requests.length === 0;
      results.push({ form, exit, upstreamCalls: scheduler.upstream.requests.length, refused });
      if (!refused) ok = false;
    } finally {
      cleanup(candidate);
    }
  }

  // Positive control: `absent` must NOT refuse -- the process stays alive
  // (never exits) through the same observation window every other form got.
  const absentCandidate = materialize("candidate");
  let absentOk: boolean;
  let absentExit: unknown;
  try {
    const scheduler = await startCandidateScheduler({ paths: absentCandidate });
    await new Promise((r) => setTimeout(r, 1500));
    absentExit = scheduler.exitInfo();
    absentOk = !scheduler.exitInfo().exited;
    await scheduler.stop();
  } finally {
    cleanup(absentCandidate);
  }
  if (!absentOk) ok = false;

  record("t18-candidate-failclosed-scheduler-startup-16-forms", ok ? "as-expected" : "DIVERGENT", ok, {
    note: "[processo-ts] -- real scheduler-process refusal over the 16 fail-closed forms (Emenda E3); absent boots normally and is the positive control, outside this group (assertion 23)",
    results,
    absentOk,
    absentExit,
  });
}

// --- probe-complementar 24: masked field `id` -- format regex survives masking, mutant kills it ----
function baselineAddEvidence(paths: RuntimePaths): { readonly ok: boolean; readonly stdout: string } {
  const result = runCandidateCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], paths);
  return { ok: /^added job [0-9a-f]{32}\n$/u.test(result.stdout), stdout: result.stdout };
}

function probeMaskedFieldId(): void {
  const baselinePaths = materialize("candidate");
  const mutantPaths = materialize("candidate");
  try {
    const baseline = baselineAddEvidence(baselinePaths);
    const mutantResult = runCandidateCronMutant(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], mutantPaths, "id");
    const mutantOk = /^added job [0-9a-f]{32}\n$/u.test(mutantResult.stdout);

    // The mutant's truncated id is only 8 hex chars -- shorter than
    // harness.ts's writeEvidence mask (which only matches the real 32-hex
    // format), so it would otherwise leak a fresh random fragment into
    // evidence on every run and break digest reproducibility for a reason
    // that has nothing to do with a real divergence. Normalize it here too.
    const normalizedMutantStdout = mutantResult.stdout.replaceAll(/\b[0-9a-f]{8}\b/gu, "<TRUNCATED-ID>");
    const baselineSha = writeEvidence("t18-masked-field-injected-divergence-id__baseline", { stdout: baseline.stdout });
    const mutantSha = writeEvidence("t18-masked-field-injected-divergence-id__mutant", { stdout: normalizedMutantStdout });

    // The two halves assertion 44 requires: (a) the gate marks the mutant
    // FAIL where baseline is PASS, (b) the digest (evidence sha) changed.
    const gateCaughtIt = baseline.ok && !mutantOk;
    const digestChanged = baselineSha !== mutantSha;
    const ok = gateCaughtIt && digestChanged;
    record("t18-masked-field-injected-divergence-id", ok ? "gate-and-digest-react" : "DIVERGENT", ok, {
      baselineOk: baseline.ok,
      mutantOk,
      gateCaughtIt,
      digestChanged,
      baselineSha,
      mutantSha,
    });
  } finally {
    cleanup(baselinePaths);
    cleanup(mutantPaths);
  }
}

// --- probe-complementar 25: masked field `created_at` -- wall-clock-window sanity, mutant kills it ----
function probeMaskedFieldCreatedAt(): void {
  const baselinePaths = materialize("candidate");
  const mutantPaths = materialize("candidate");
  try {
    const beforeBaseline = Date.now() / 1000;
    runCandidateCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], baselinePaths);
    const afterBaseline = Date.now() / 1000;
    const baselineJob = (JSON.parse(readFileSync(jobsPathOf(baselinePaths), "utf8")) as { jobs: { created_at: number }[] })
      .jobs[0];
    const baselineOk = baselineJob !== undefined && baselineJob.created_at >= beforeBaseline && baselineJob.created_at <= afterBaseline;

    runCandidateCronMutant(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], mutantPaths, "createdat");
    const mutantJob = (JSON.parse(readFileSync(jobsPathOf(mutantPaths), "utf8")) as { jobs: { created_at: number }[] }).jobs[0];
    const mutantOk = mutantJob !== undefined && mutantJob.created_at >= beforeBaseline && mutantJob.created_at <= afterBaseline;

    // `created_at` is a real wall-clock epoch -- writing its raw value would
    // make this evidence (and the sha computed over it) different on every
    // run, breaking the aggregate suite digest's reproducibility for a
    // reason that has nothing to do with a real divergence. Record only the
    // window-membership boolean this probe actually tests.
    const baselineSha = writeEvidence("t18-masked-field-injected-divergence-created-at__baseline", { insideWindow: baselineOk });
    const mutantSha = writeEvidence("t18-masked-field-injected-divergence-created-at__mutant", { insideWindow: mutantOk });

    const gateCaughtIt = baselineOk && !mutantOk;
    const digestChanged = baselineSha !== mutantSha;
    const ok = gateCaughtIt && digestChanged;
    record("t18-masked-field-injected-divergence-created-at", ok ? "gate-and-digest-react" : "DIVERGENT", ok, {
      baselineInsideWindow: baselineOk,
      mutantInsideWindow: mutantOk,
      gateCaughtIt,
      digestChanged,
      baselineSha,
      mutantSha,
    });
  } finally {
    cleanup(baselinePaths);
    cleanup(mutantPaths);
  }
}

// --- probe-complementar 26: masked field `last_run_at` -- restart-refire sanity, mutant kills it ----
async function probeMaskedFieldLastRunAt(): Promise<void> {
  async function measure(mutant: string | undefined): Promise<number> {
    const paths = materialize("candidate");
    try {
      const due = String(Date.now() / 1000 - 3600);
      runCandidateCron(["add", "--name", "n1", "--prompt", "SCEN:ok", "--at", due], paths);
      const mutantOption = mutant === undefined ? {} : { mutant };
      const first = await startCandidateScheduler({ paths, ...mutantOption });
      await waitFor(() => first.upstream.requests.length >= 1, 8000);
      await new Promise((r) => setTimeout(r, 300));
      await first.stop();

      const second = await startCandidateScheduler({ paths, ...mutantOption });
      await new Promise((r) => setTimeout(r, 2000));
      await second.stop();
      const secondCalls = second.upstream.requests.length;
      cleanup(paths);
      return secondCalls;
    } catch (error) {
      cleanup(paths);
      throw error;
    }
  }

  const baselineSecondCalls = await measure(undefined);
  const mutantSecondCalls = await measure("markrun");

  const baselineOk = baselineSecondCalls === 0;
  const mutantOk = mutantSecondCalls === 0;
  const baselineSha = writeEvidence("t18-masked-field-injected-divergence-last-run-at__baseline", { secondBootCalls: baselineSecondCalls });
  const mutantSha = writeEvidence("t18-masked-field-injected-divergence-last-run-at__mutant", { secondBootCalls: mutantSecondCalls });

  const gateCaughtIt = baselineOk && !mutantOk;
  const digestChanged = baselineSha !== mutantSha;
  const ok = gateCaughtIt && digestChanged;
  record("t18-masked-field-injected-divergence-last-run-at", ok ? "gate-and-digest-react" : "DIVERGENT", ok, {
    baselineSecondBootCalls: baselineSecondCalls,
    mutantSecondBootCalls: mutantSecondCalls,
    baselineOk,
    mutantOk,
    gateCaughtIt,
    digestChanged,
    baselineSha,
    mutantSha,
  });
}

// --- assertion 24's own guard self-test: destroy-mutant and preserve-append-mutant must flip scenario 11/12's ADR verdict to an observed FAIL ----
function probeAssertion24GuardKills(): void {
  const results: unknown[] = [];
  let ok = true;

  {
    const form = ADD_DESTROYS_11[0] as string; // "empty"
    const paths = materialize("candidate");
    try {
      plantForm(form, paths);
      const baseline = runCandidateCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], paths);
      const baselineRefused = baseline.code !== 0;
      const mutantPaths = materialize("candidate");
      plantForm(form, mutantPaths);
      const mutantResult = runCandidateCronMutant(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], mutantPaths, "destroy");
      const mutantSucceeded = mutantResult.code === 0;
      const killed = baselineRefused && mutantSucceeded;
      results.push({ mutant: "destroy", form, baselineRefused, mutantSucceeded, killed });
      if (!killed) ok = false;
      cleanup(mutantPaths);
    } finally {
      cleanup(paths);
    }
  }

  {
    const form = ADD_PRESERVES_AND_APPENDS_4[0] as string; // "entry_number"
    const paths = materialize("candidate");
    try {
      plantForm(form, paths);
      const baseline = runCandidateCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], paths);
      const baselineRefused = baseline.code !== 0;
      const mutantPaths = materialize("candidate");
      plantForm(form, mutantPaths);
      const mutantResult = runCandidateCronMutant(
        ["add", "--name", "n1", "--prompt", "p1", "--interval", "5"],
        mutantPaths,
        "preserve-append",
      );
      const mutantSucceeded = mutantResult.code === 0;
      const killed = baselineRefused && mutantSucceeded;
      results.push({ mutant: "preserve-append", form, baselineRefused, mutantSucceeded, killed });
      if (!killed) ok = false;
      cleanup(mutantPaths);
    } finally {
      cleanup(paths);
    }
  }

  record("t18-assertion24-guard-mutation-kills", ok ? "both-mutations-killed" : "DIVERGENT", ok, { results });
}

runGuards();
await probeR7TickNonDictAbort();
await probeConcurrentAddNoLostUpdate();
await probeSchedulerStartupRefusal();
probeMaskedFieldId();
probeMaskedFieldCreatedAt();
await probeMaskedFieldLastRunAt();
probeAssertion24GuardKills();

const digestInput = projections
  .toSorted((a, b) => a.id.localeCompare(b.id))
  .map(({ id, sha }) => `${id}=${sha}\n`)
  .join("");
const digest = createHash("sha256").update(digestInput, "utf8").digest("hex");
const result = {
  suite: "t18-cron-probes",
  scenarios: projections.length,
  failures,
  localDay: localDay(),
  utcDay: utcDay(),
  digest,
  digestFormula: "sha256(sorted UTF-8 lines id=projectionSha256\\n, trailing newline included)",
  projections,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = failures === 0 && projections.length === 7 ? 0 : 1;
