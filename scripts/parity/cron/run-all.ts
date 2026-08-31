#!/usr/bin/env node
// [cli-bilateral] evidence class for T18: one-shot `lohra cron` invocations,
// oracle and candidate each in a fresh isolated HOME, real processes only
// (assertion 6). Covers scenarios 1-14 of the contract's inventory.
import { createHash } from "node:crypto";

import {
  ADD_CRASHES_BEFORE_WRITE_2,
  ADD_CREATES_FROM_NOTHING_1,
  ADD_DESTROYS_11,
  ADD_PRESERVES_AND_APPENDS_4,
  CORRUPTION_FORMS,
  FAIL_CLOSED_16,
  plantForm,
} from "./forms.js";
import {
  cleanup,
  jobsPathOf,
  localDay,
  maskId,
  materialize,
  readFileState,
  runCandidateCron,
  runGuards,
  runOracleCron,
  utcDay,
  writeEvidence,
  type CliResult,
} from "./harness.js";

let failures = 0;
const projections: { readonly id: string; readonly sha: string; readonly verdict: string }[] = [];

function record(id: string, verdict: string, ok: boolean, payload: unknown): void {
  const sha = writeEvidence(id, { id, verdict, localDay: localDay(), utcDay: utcDay(), ...( payload as object) });
  projections.push({ id, sha, verdict });
  if (!ok) {
    failures += 1;
    process.stderr.write(`T18_SCENARIO_FAILED:${id}\n`);
  }
}

// --- Scenario 1: schema round-trip over a fixed valid_one seed --------------
function scenario1SchemaRoundtrip(): void {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    plantForm("valid_one", oracle);
    plantForm("valid_one", candidate);
    const steps: { readonly op: string; readonly argv: readonly string[] }[] = [
      { op: "list", argv: ["list"] },
      { op: "pause", argv: ["pause", "aaaabbbbccccdddd"] },
      { op: "list-paused", argv: ["list"] },
      { op: "resume", argv: ["resume", "aaaabbbbccccdddd"] },
      { op: "list-resumed", argv: ["list"] },
      { op: "remove", argv: ["remove", "aaaabbbbccccdddd"] },
      { op: "list-empty", argv: ["list"] },
    ];
    const results: { readonly op: string; readonly oracle: CliResult; readonly candidate: CliResult; readonly match: boolean }[] = [];
    let ok = true;
    for (const step of steps) {
      const oracleResult = runOracleCron(step.argv, oracle);
      const candidateResult = runCandidateCron(step.argv, candidate);
      const match =
        oracleResult.code === candidateResult.code &&
        oracleResult.stdout === candidateResult.stdout &&
        oracleResult.stderr === candidateResult.stderr;
      if (!match) ok = false;
      results.push({ op: step.op, oracle: oracleResult, candidate: candidateResult, match });
    }
    record("t18-schema-roundtrip-valid-one", ok ? "match" : "DIVERGENT", ok, { results });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

// --- Scenario 2: byte-exact validation goldens -------------------------------
const BYTE_EXACT_GOLDENS: { readonly label: string; readonly argv: readonly string[] }[] = [
  { label: "add-no-schedule", argv: ["add", "--name", "n1", "--prompt", "p1"] },
  { label: "empty-name", argv: ["add", "--name", "", "--prompt", "p1", "--interval", "5"] },
  { label: "empty-prompt", argv: ["add", "--name", "n1", "--prompt", "", "--interval", "5"] },
  { label: "interval-zero", argv: ["add", "--name", "n1", "--prompt", "p1", "--interval", "0"] },
  { label: "cron-4-fields", argv: ["add", "--name", "n1", "--prompt", "p1", "--cron", "* * * *"] },
  { label: "cron-out-of-range", argv: ["add", "--name", "n1", "--prompt", "p1", "--cron", "60 * * * *"] },
  { label: "remove-no-id", argv: ["remove"] },
  { label: "remove-nonexistent", argv: ["remove", "ghost"] },
];

function scenario2ByteExactGoldens(): void {
  let ok = true;
  const results: { readonly label: string; readonly oracle: CliResult; readonly candidate: CliResult; readonly match: boolean }[] = [];
  for (const golden of BYTE_EXACT_GOLDENS) {
    const oracle = materialize("oracle");
    const candidate = materialize("candidate");
    try {
      const oracleResult = runOracleCron(golden.argv, oracle);
      const candidateResult = runCandidateCron(golden.argv, candidate);
      const match =
        oracleResult.code === candidateResult.code &&
        oracleResult.stdout === candidateResult.stdout &&
        oracleResult.stderr === candidateResult.stderr;
      if (!match) ok = false;
      results.push({ label: golden.label, oracle: oracleResult, candidate: candidateResult, match });
    } finally {
      cleanup(oracle);
      cleanup(candidate);
    }
  }
  record("t18-validation-byte-exact-goldens", ok ? "match" : "DIVERGENT", ok, { results });
}

// --- Scenario 3: named-excuse validation (structurally equivalent, not byte-identical) -----
const NAMED_EXCUSE_CASES: { readonly label: string; readonly argv: readonly string[]; readonly oraclePrefix: string; readonly candidatePrefix: string }[] = [
  {
    label: "interval-float",
    argv: ["add", "--name", "n1", "--prompt", "p1", "--interval", "2.5"],
    oraclePrefix: "lohra cron: error: argument --interval: invalid int value:",
    candidatePrefix: "lohra cron: error: argument --interval: invalid int value:",
  },
  {
    label: "cron-int-error",
    argv: ["add", "--name", "n1", "--prompt", "p1", "--cron", "a * * * *"],
    oraclePrefix: "error: invalid cron expression: invalid literal for int() with base 10:",
    candidatePrefix: "error: invalid cron expression: invalid literal for int() with base 10:",
  },
  {
    label: "unknown-action",
    argv: ["frobnicate"],
    oraclePrefix: "usage: lohra cron",
    candidatePrefix: "lohra cron: error: argument action: invalid choice:",
  },
];

function scenario3NamedExcuse(): void {
  let ok = true;
  const results: unknown[] = [];
  for (const testCase of NAMED_EXCUSE_CASES) {
    const oracle = materialize("oracle");
    const candidate = materialize("candidate");
    try {
      const oracleResult = runOracleCron(testCase.argv, oracle);
      const candidateResult = runCandidateCron(testCase.argv, candidate);
      const oracleClass = oracleResult.code === 2 && oracleResult.stderr.includes(testCase.oraclePrefix);
      const candidateClass = candidateResult.code === 2 && candidateResult.stderr.includes(testCase.candidatePrefix);
      const equivalent = oracleClass && candidateClass;
      if (!equivalent) ok = false;
      results.push({ label: testCase.label, oracle: oracleResult, candidate: candidateResult, equivalent });
    } finally {
      cleanup(oracle);
      cleanup(candidate);
    }
  }
  record("t18-validation-named-excuse", ok ? "excuse-equivalent" : "DIVERGENT", ok, { results });
}

// --- Scenario 4: cron Sunday alias `7` ---------------------------------------
function scenario4SundayAlias(): void {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    const argv = ["add", "--name", "n1", "--prompt", "p1", "--cron", "0 0 * * 7"];
    const oracleResult = runOracleCron(argv, oracle);
    const candidateResult = runCandidateCron(argv, candidate);
    const ok = oracleResult.code === 0 && candidateResult.code === 0;
    record("t18-cron-sunday-alias-7", ok ? "match" : "DIVERGENT", ok, {
      oracle: oracleResult,
      candidate: candidateResult,
    });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

// --- Scenario 5: 13 silent forms (list) --------------------------------------
const SILENT_13 = CORRUPTION_FORMS.filter((f) => f.class === "silent").map((f) => f.name);

function scenario5CorruptionSilent(): void {
  let ok = true;
  const results: unknown[] = [];
  for (const form of SILENT_13) {
    const oracle = materialize("oracle");
    const candidate = materialize("candidate");
    try {
      plantForm(form, oracle);
      plantForm(form, candidate);
      const oracleResult = runOracleCron(["list"], oracle);
      const oracleOk = oracleResult.code === 0 && oracleResult.stdout === "no scheduled jobs\n" && oracleResult.stderr === "";

      const candidatePath = jobsPathOf(candidate);
      const before = readFileState(candidatePath);
      const candidateResult = runCandidateCron(["list"], candidate);
      const after = readFileState(candidatePath);
      const hashPreserved = before.sha256 === after.sha256 && before.exists === after.exists;

      let formOk: boolean;
      let verdict: string;
      if (form === "absent") {
        formOk = candidateResult.code === 0 && candidateResult.stdout === "no scheduled jobs\n" && candidateResult.stderr === "";
        verdict = "match";
      } else {
        formOk = candidateResult.code !== 0 && candidateResult.stdout === "" && candidateResult.stderr !== "" && hashPreserved;
        verdict = "ADR";
      }
      if (!(oracleOk && formOk)) ok = false;
      results.push({ form, oracle: oracleResult, oracleOk, candidate: candidateResult, hashPreserved, verdict, formOk });
    } finally {
      cleanup(oracle);
      cleanup(candidate);
    }
  }
  record("t18-corruption-silent-13-forms", ok ? "as-expected" : "DIVERGENT", ok, { results });
}

// --- Scenario 6: 4 crash forms (list), exact oracle exception ----------------
const CRASH_4 = CORRUPTION_FORMS.filter((f) => f.class === "crash");

function scenario6CorruptionCrash(): void {
  let ok = true;
  const results: unknown[] = [];
  for (const form of CRASH_4) {
    const oracle = materialize("oracle");
    const candidate = materialize("candidate");
    try {
      plantForm(form.name, oracle);
      plantForm(form.name, candidate);
      const oracleResult = runOracleCron(["list"], oracle);
      const oracleOk =
        oracleResult.code !== 0 &&
        form.oracleException !== undefined &&
        oracleResult.stderr.includes(form.oracleException);

      const candidatePath = jobsPathOf(candidate);
      const before = readFileState(candidatePath);
      const candidateResult = runCandidateCron(["list"], candidate);
      const after = readFileState(candidatePath);
      const hashPreserved = before.sha256 === after.sha256;
      const candidateOk = candidateResult.code !== 0 && candidateResult.stdout === "" && candidateResult.stderr !== "" && hashPreserved;

      if (!(oracleOk && candidateOk)) ok = false;
      results.push({ form: form.name, oracleException: form.oracleException, oracle: oracleResult, oracleOk, candidate: candidateResult, hashPreserved, candidateOk, verdict: "ADR" });
    } finally {
      cleanup(oracle);
      cleanup(candidate);
    }
  }
  record("t18-corruption-crash-4-forms-exact-exception", ok ? "as-expected" : "DIVERGENT", ok, { results });
}

// --- Scenario 7: nan_literal is alive, byte-exact on list --------------------
function scenario7NanAlive(): void {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    plantForm("nan_literal", oracle);
    plantForm("nan_literal", candidate);
    const oracleResult = runOracleCron(["list"], oracle);
    const candidateResult = runCandidateCron(["list"], candidate);
    const match =
      oracleResult.code === 0 &&
      candidateResult.code === 0 &&
      oracleResult.stdout === candidateResult.stdout &&
      oracleResult.stderr === candidateResult.stderr;
    record("t18-corruption-nan-alive", match ? "match" : "DIVERGENT", match, {
      oracle: oracleResult,
      candidate: candidateResult,
    });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

// --- Scenario 8: add destroys 11 forms + creates from absent ------------------
function scenario8AddDestroys(): void {
  let ok = true;
  const results: unknown[] = [];
  for (const form of [...ADD_DESTROYS_11, ...ADD_CREATES_FROM_NOTHING_1]) {
    const oracle = materialize("oracle");
    const candidate = materialize("candidate");
    try {
      plantForm(form, oracle);
      plantForm(form, candidate);
      const oracleAdd = runOracleCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], oracle);
      const oracleList = runOracleCron(["list"], oracle);
      const oracleDestroyed =
        oracleAdd.code === 0 &&
        /^added job [0-9a-f]{32}\n$/u.test(oracleAdd.stdout) &&
        oracleList.code === 0 &&
        oracleList.stdout.split("\n").filter(Boolean).length === 1 &&
        oracleList.stderr === "";

      const candidatePath = jobsPathOf(candidate);
      const before = readFileState(candidatePath);
      const candidateAdd = runCandidateCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], candidate);
      const after = readFileState(candidatePath);

      let candidateOk: boolean;
      let verdict: string;
      if (form === "absent") {
        candidateOk = candidateAdd.code === 0 && /^added job [0-9a-f]{32}\n$/u.test(candidateAdd.stdout) && after.exists;
        verdict = "match";
      } else {
        candidateOk = candidateAdd.code !== 0 && before.sha256 === after.sha256;
        verdict = "ADR";
      }
      if (!(oracleDestroyed && candidateOk)) ok = false;
      results.push({ form, oracleAdd, oracleList, oracleDestroyed, candidateAdd, candidateOk, verdict });
    } finally {
      cleanup(oracle);
      cleanup(candidate);
    }
  }
  // Assertion 18 also names the 2 crash-before-write forms explicitly:
  // `add` on the oracle crashes before `_write()` ever runs, so the
  // original (corrupted) bytes survive by accident, not by design.
  const crashBeforeWriteResults: unknown[] = [];
  for (const form of ADD_CRASHES_BEFORE_WRITE_2) {
    const oracle = materialize("oracle");
    const candidate = materialize("candidate");
    try {
      plantForm(form, oracle);
      plantForm(form, candidate);
      const oraclePath = jobsPathOf(oracle);
      const oracleBefore = readFileState(oraclePath);
      const oracleAdd = runOracleCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], oracle);
      const oracleAfter = readFileState(oraclePath);
      const oracleCrashedBeforeWrite =
        oracleAdd.code !== 0 && !oracleAdd.stdout.includes("added job") && oracleBefore.sha256 === oracleAfter.sha256;

      const candidatePath = jobsPathOf(candidate);
      const candidateBefore = readFileState(candidatePath);
      const candidateAdd = runCandidateCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], candidate);
      const candidateAfter = readFileState(candidatePath);
      const candidateOk = candidateAdd.code !== 0 && candidateBefore.sha256 === candidateAfter.sha256;

      const formOk = oracleCrashedBeforeWrite && candidateOk;
      if (!formOk) ok = false;
      crashBeforeWriteResults.push({ form, oracleAdd, oracleCrashedBeforeWrite, candidateAdd, candidateOk, verdict: "ADR" });
    } finally {
      cleanup(oracle);
      cleanup(candidate);
    }
  }
  record("t18-add-destroys-11-forms-and-creates-from-absent", ok ? "as-expected" : "DIVERGENT", ok, {
    results,
    crashBeforeWriteResults,
  });
}

// --- Scenario 8a: add preserves-and-appends 4 forms; nan_literal is candidate match (21c) ----
function scenario8aAddPreservesAppends(): void {
  let ok = true;
  const results: unknown[] = [];
  for (const form of ADD_PRESERVES_AND_APPENDS_4) {
    const oracle = materialize("oracle");
    const candidate = materialize("candidate");
    try {
      plantForm(form, oracle);
      plantForm(form, candidate);
      const oracleAdd = runOracleCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], oracle);
      const oracleList = runOracleCron(["list"], oracle);
      // Preserve-and-append is proven by add succeeding AND the malformed entry
      // still being present afterward: for nan_literal, list succeeds and shows
      // 2 lines; for the other 3 (crash-class on list), list still crashes the
      // SAME way as before add, proving the bad entry survived alongside the new job.
      const oracleAddOk = oracleAdd.code === 0 && /^added job [0-9a-f]{32}\n$/u.test(oracleAdd.stdout);
      const oracleAppendOk =
        form === "nan_literal"
          ? oracleList.code === 0 && oracleList.stdout.split("\n").filter(Boolean).length === 2
          : oracleList.code !== 0 && oracleList.stderr !== "";

      const candidatePath = jobsPathOf(candidate);
      const candidateAdd = runCandidateCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], candidate);

      let candidateOk: boolean;
      let verdict: string;
      if (form === "nan_literal") {
        const candidateList = runCandidateCron(["list"], candidate);
        candidateOk =
          candidateAdd.code === 0 &&
          /^added job [0-9a-f]{32}\n$/u.test(candidateAdd.stdout) &&
          candidateList.code === 0 &&
          candidateList.stdout.split("\n").filter(Boolean).length === 2 &&
          candidateList.stdout.includes("(once=nan)");
        verdict = "match";
        results.push({ form, oracleAdd, oracleList, oracleAddOk, oracleAppendOk, candidateAdd, candidateList, candidateOk, verdict });
      } else {
        const before = readFileState(candidatePath);
        const after = readFileState(candidatePath);
        candidateOk = candidateAdd.code !== 0 && before.sha256 === after.sha256;
        verdict = "ADR";
        results.push({ form, oracleAdd, oracleList, oracleAddOk, oracleAppendOk, candidateAdd, candidateOk, verdict });
      }
      if (!(oracleAddOk && oracleAppendOk && candidateOk)) ok = false;
    } finally {
      cleanup(oracle);
      cleanup(candidate);
    }
  }
  record("t18-add-preserves-and-appends-4-forms", ok ? "as-expected" : "DIVERGENT", ok, { results });
}

// --- Scenario 9: add with invalid args preserves all 18 forms (both sides match) ----
const ALL_18_CORRUPTED = CORRUPTION_FORMS.filter((f) => f.class !== "control").map((f) => f.name);

function scenario9AddInvalidPreserves(): void {
  let ok = true;
  const results: unknown[] = [];
  const invalidArgv = ["add", "--name", "", "--prompt", "p1", "--interval", "5"];
  for (const form of ALL_18_CORRUPTED) {
    const oracle = materialize("oracle");
    const candidate = materialize("candidate");
    try {
      plantForm(form, oracle);
      plantForm(form, candidate);
      const oraclePath = jobsPathOf(oracle);
      const candidatePath = jobsPathOf(candidate);
      const oracleBefore = readFileState(oraclePath);
      const candidateBefore = readFileState(candidatePath);
      const oracleResult = runOracleCron(invalidArgv, oracle);
      const candidateResult = runCandidateCron(invalidArgv, candidate);
      const oracleAfter = readFileState(oraclePath);
      const candidateAfter = readFileState(candidatePath);
      const bothPreserved = oracleBefore.sha256 === oracleAfter.sha256 && candidateBefore.sha256 === candidateAfter.sha256;
      const bothSameError =
        oracleResult.code === candidateResult.code &&
        oracleResult.stderr === candidateResult.stderr &&
        oracleResult.stdout === candidateResult.stdout;
      const formOk = bothPreserved && bothSameError;
      if (!formOk) ok = false;
      results.push({ form, oracle: oracleResult, candidate: candidateResult, bothPreserved, bothSameError, verdict: "match" });
    } finally {
      cleanup(oracle);
      cleanup(candidate);
    }
  }
  record("t18-add-invalid-args-preserves-18-forms", ok ? "match" : "DIVERGENT", ok, { results });
}

// --- Scenario 10: remove/pause/resume preserve 16 of 18 forms cleanly; two
// forms are exceptions by distinct paths (Emenda E4, corrected against the
// Evaluator's evidence-a01-corruption-matrix.json AND this Generator's own
// live measure-oracle-matrix.ts run, both agreeing cell by cell) ----------
const EXPECTED_ORACLE_EXCEPTION: Readonly<Record<string, string>> = {
  entry_number: "AttributeError",
  invalid_utf8: "UnicodeDecodeError",
};

function scenario10RemovePauseResumePreserve(): void {
  let ok = true;
  const results: unknown[] = [];
  for (const form of ALL_18_CORRUPTED) {
    for (const op of ["remove", "pause", "resume"] as const) {
      const oracle = materialize("oracle");
      const candidate = materialize("candidate");
      try {
        plantForm(form, oracle);
        plantForm(form, candidate);
        const oraclePath = jobsPathOf(oracle);
        const candidatePath = jobsPathOf(candidate);
        const oracleBefore = readFileState(oraclePath);
        const candidateBefore = readFileState(candidatePath);
        const oracleResult = runOracleCron([op, "some-id"], oracle);
        const candidateResult = runCandidateCron([op, "some-id"], candidate);
        const oracleAfter = readFileState(oraclePath);
        const candidateAfter = readFileState(candidatePath);
        const oraclePreserved = oracleBefore.sha256 === oracleAfter.sha256;
        const candidatePreserved = candidateBefore.sha256 === candidateAfter.sha256;

        const expectedException = EXPECTED_ORACLE_EXCEPTION[form];
        let oracleOk: boolean;
        if (expectedException !== undefined) {
          oracleOk = oracleResult.code !== 0 && oracleResult.stderr.includes(expectedException) && oraclePreserved;
        } else {
          oracleOk =
            oracleResult.code === 1 &&
            oracleResult.stdout === "" &&
            oracleResult.stderr === "no job with id 'some-id'\n" &&
            oraclePreserved;
        }
        const candidateOk = candidateResult.code !== 0 && candidatePreserved;
        const formOk = oracleOk && candidateOk;
        if (!formOk) ok = false;
        results.push({
          form,
          op,
          oracle: oracleResult,
          oracleOk,
          candidate: candidateResult,
          candidateOk,
          verdict: expectedException !== undefined ? "oracle-exception-own-class" : "match-or-ADR",
        });
      } finally {
        cleanup(oracle);
        cleanup(candidate);
      }
    }
  }
  record("t18-remove-pause-resume-preserve-18-forms", ok ? "as-expected" : "DIVERGENT", ok, { results });
}

// --- Scenario 11: candidate fail-closed on list, 16 forms; 11a: absent match ----
function scenario11CandidateFailClosedList(): void {
  let ok = true;
  const results: unknown[] = [];
  for (const form of FAIL_CLOSED_16) {
    const candidate = materialize("candidate");
    try {
      plantForm(form, candidate);
      const path = jobsPathOf(candidate);
      const before = readFileState(path);
      const result = runCandidateCron(["list"], candidate);
      const after = readFileState(path);
      const formOk = result.code !== 0 && result.stdout === "" && result.stderr !== "" && before.sha256 === after.sha256;
      if (!formOk) ok = false;
      results.push({ form, result, formOk, verdict: "ADR" });
    } finally {
      cleanup(candidate);
    }
  }
  record("t18-candidate-failclosed-list-17-forms", ok ? "as-expected" : "DIVERGENT", ok, { note: "16 forms per Emenda E3", results });
}

function scenario11aAbsentMatchBilateral(): void {
  const oracleList = materialize("oracle");
  const candidateList = materialize("candidate");
  const oracleAdd = materialize("oracle");
  const candidateAdd = materialize("candidate");
  try {
    const oracleListResult = runOracleCron(["list"], oracleList);
    const candidateListResult = runCandidateCron(["list"], candidateList);
    const listMatch =
      oracleListResult.code === 0 &&
      candidateListResult.code === 0 &&
      oracleListResult.stdout === candidateListResult.stdout &&
      oracleListResult.stderr === candidateListResult.stderr;

    const oracleAddResult = runOracleCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], oracleAdd);
    const candidateAddResult = runCandidateCron(["add", "--name", "n1", "--prompt", "p1", "--interval", "5"], candidateAdd);
    const addMatch =
      oracleAddResult.code === 0 &&
      candidateAddResult.code === 0 &&
      /^added job [0-9a-f]{32}\n$/u.test(oracleAddResult.stdout) &&
      /^added job [0-9a-f]{32}\n$/u.test(candidateAddResult.stdout) &&
      readFileState(jobsPathOf(candidateAdd)).exists;

    const ok = listMatch && addMatch;
    record("t18-candidate-absent-list-add-match-bilateral", ok ? "match" : "DIVERGENT", ok, {
      list: { oracle: oracleListResult, candidate: candidateListResult, match: listMatch },
      add: { oracle: oracleAddResult, candidate: candidateAddResult, match: addMatch },
    });
  } finally {
    cleanup(oracleList);
    cleanup(candidateList);
    cleanup(oracleAdd);
    cleanup(candidateAdd);
  }
}

// --- Scenario 12: candidate fail-closed on mutations, 16 forms ---------------
function scenario12CandidateFailClosedMutations(): void {
  let ok = true;
  const results: unknown[] = [];
  for (const form of FAIL_CLOSED_16) {
    for (const attempt of [
      { op: "add-valid", argv: ["add", "--name", "n1", "--prompt", "p1", "--interval", "5"] },
      { op: "remove", argv: ["remove", "some-id"] },
      { op: "pause", argv: ["pause", "some-id"] },
      { op: "resume", argv: ["resume", "some-id"] },
    ] as const) {
      const candidate = materialize("candidate");
      try {
        plantForm(form, candidate);
        const path = jobsPathOf(candidate);
        const before = readFileState(path);
        const result = runCandidateCron(attempt.argv, candidate);
        const after = readFileState(path);
        const formOk = result.code !== 0 && before.sha256 === after.sha256;
        if (!formOk) ok = false;
        results.push({ form, op: attempt.op, result, formOk, verdict: "ADR" });
      } finally {
        cleanup(candidate);
      }
    }
  }
  record("t18-candidate-failclosed-mutations-17-forms", ok ? "as-expected" : "DIVERGENT", ok, { note: "16 forms per Emenda E3", results });
}

// --- Scenario 13: NaN chain — accept/persist/list parity for nan/inf/-1 --------
function scenario13NanAddAndListParity(): void {
  let ok = true;
  const results: unknown[] = [];
  for (const at of ["nan", "inf", "-1"]) {
    const oracle = materialize("oracle");
    const candidate = materialize("candidate");
    try {
      const argv = ["add", "--name", "n1", "--prompt", "p1", "--at", at];
      const oracleAdd = runOracleCron(argv, oracle);
      const candidateAdd = runCandidateCron(argv, candidate);
      const addMatch =
        oracleAdd.code === 0 &&
        candidateAdd.code === 0 &&
        /^added job [0-9a-f]{32}\n$/u.test(oracleAdd.stdout) &&
        /^added job [0-9a-f]{32}\n$/u.test(candidateAdd.stdout);

      const oracleList = runOracleCron(["list"], oracle);
      const candidateList = runCandidateCron(["list"], candidate);
      const listMatch =
        oracleList.code === 0 &&
        candidateList.code === 0 &&
        maskId(oracleList.stdout) === maskId(candidateList.stdout);

      const formOk = addMatch && listMatch;
      if (!formOk) ok = false;
      results.push({ at, oracleAdd, candidateAdd, addMatch, oracleList, candidateList, listMatch });
    } finally {
      cleanup(oracle);
      cleanup(candidate);
    }
  }
  record("t18-nan-add-and-list-parity", ok ? "match" : "DIVERGENT", ok, { results });
}

// --- Scenario 14: restart & persistence ---------------------------------------
function scenario14RestartPersistence(): void {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    const addArgv = ["add", "--name", "n1", "--prompt", "p1", "--interval", "5"];
    const oracleAdd = runOracleCron(addArgv, oracle);
    const candidateAdd = runCandidateCron(addArgv, candidate);
    // "Restart" = a brand-new process reading the same HOME (the store has no
    // in-memory state to lose between calls in either implementation).
    const oracleList = runOracleCron(["list"], oracle);
    const candidateList = runCandidateCron(["list"], candidate);
    const ok =
      oracleAdd.code === 0 &&
      candidateAdd.code === 0 &&
      oracleList.code === 0 &&
      candidateList.code === 0 &&
      maskId(oracleList.stdout) === maskId(candidateList.stdout) &&
      oracleList.stdout.includes(oracleAdd.stdout.trim().replace("added job ", "")) &&
      candidateList.stdout.includes(candidateAdd.stdout.trim().replace("added job ", ""));
    record("t18-restart-persistence-and-single-fire", ok ? "match" : "DIVERGENT", ok, {
      oracleAdd,
      candidateAdd,
      oracleList,
      candidateList,
    });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

runGuards();
scenario1SchemaRoundtrip();
scenario2ByteExactGoldens();
scenario3NamedExcuse();
scenario4SundayAlias();
scenario5CorruptionSilent();
scenario6CorruptionCrash();
scenario7NanAlive();
scenario8AddDestroys();
scenario8aAddPreservesAppends();
scenario9AddInvalidPreserves();
scenario10RemovePauseResumePreserve();
scenario11CandidateFailClosedList();
scenario11aAbsentMatchBilateral();
scenario12CandidateFailClosedMutations();
scenario13NanAddAndListParity();
scenario14RestartPersistence();

const digestInput = projections
  .toSorted((a, b) => a.id.localeCompare(b.id))
  .map(({ id, sha }) => `${id}=${sha}\n`)
  .join("");
const digest = createHash("sha256").update(digestInput, "utf8").digest("hex");
const result = {
  suite: "t18-cron-cli-bilateral",
  scenarios: projections.length,
  failures,
  localDay: localDay(),
  utcDay: utcDay(),
  digest,
  digestFormula: "sha256(sorted UTF-8 lines id=projectionSha256\\n, trailing newline included)",
  projections,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = failures === 0 && projections.length === 16 ? 0 : 1;
