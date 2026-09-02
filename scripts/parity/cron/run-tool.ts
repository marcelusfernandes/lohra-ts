#!/usr/bin/env node
// [cli-bilateral] evidence for the `cronjob` tool (decision 10, assertions
// 39-41): real process on both sides, built from the SAME registry/dispatch
// wiring a real conversation turn uses (never a bare in-process
// `CronTool().handle()` call).
import { createHash } from "node:crypto";

import {
  cleanup,
  localDay,
  maskId,
  materialize,
  runOracleTool,
  runCandidateTool,
  runGuards,
  utcDay,
  writeEvidence,
} from "./harness.js";

let failures = 0;
const projections: { readonly id: string; readonly sha: string; readonly verdict: string }[] = [];

function record(id: string, verdict: string, ok: boolean, payload: unknown): void {
  const sha = writeEvidence(id, {
    id,
    verdict,
    localDay: localDay(),
    utcDay: utcDay(),
    ...(payload as object),
  });
  projections.push({ id, sha, verdict });
  if (!ok) {
    failures += 1;
    process.stderr.write(`T18_SCENARIO_FAILED:${id}\n`);
  }
}

// --- Scenario 27: add -> list -> pause -> resume -> remove round-trip (assertions 39-40) ----
function scenario27ToolRoundtrip(): void {
  const oracle = materialize("oracle");
  const candidate = materialize("candidate");
  try {
    const steps: { readonly op: string; readonly action: string; readonly needsJobId: boolean }[] =
      [
        { op: "add", action: "add", needsJobId: false },
        { op: "list-1", action: "list", needsJobId: false },
        { op: "pause", action: "pause", needsJobId: true },
        { op: "resume", action: "resume", needsJobId: true },
        { op: "remove", action: "remove", needsJobId: true },
        { op: "list-2", action: "list", needsJobId: false },
      ];
    const results: unknown[] = [];
    let ok = true;
    // Each side mints its own random job id on `add` -- they're never equal,
    // and never compared directly (masked), so each side's later steps must
    // target ITS OWN id, not the other side's.
    let oracleJobId: string | undefined;
    let candidateJobId: string | undefined;

    for (const step of steps) {
      const baseArgs: Record<string, unknown> =
        step.action === "add"
          ? { action: "add", name: "n1", prompt: "p1", schedule_type: "interval", value: 5 }
          : { action: step.action };
      const oracleArgs = step.needsJobId ? { ...baseArgs, job_id: oracleJobId } : baseArgs;
      const candidateArgs = step.needsJobId ? { ...baseArgs, job_id: candidateJobId } : baseArgs;
      const oracleResult = runOracleTool(oracleArgs, oracle);
      const candidateResult = runCandidateTool(candidateArgs, candidate);
      const match =
        maskId(oracleResult.stdout) === maskId(candidateResult.stdout) &&
        oracleResult.code === candidateResult.code;
      if (!match) ok = false;
      results.push({
        op: step.op,
        oracle: { args: oracleArgs, result: oracleResult },
        candidate: { args: candidateArgs, result: candidateResult },
        match,
      });

      if (step.op === "add") {
        oracleJobId = (JSON.parse(oracleResult.stdout) as { job_id?: string }).job_id;
        candidateJobId = (JSON.parse(candidateResult.stdout) as { job_id?: string }).job_id;
      }
    }

    // Error mapping (assertion 40): CronError -> tool_error(str(exc)), same
    // byte-exact class as decision 12's `add` validation goldens where
    // applicable (empty name).
    const invalidAdd = {
      action: "add",
      name: "",
      prompt: "p1",
      schedule_type: "interval",
      value: 5,
    };
    const oracleInvalid = runOracleTool(invalidAdd, oracle);
    const candidateInvalid = runCandidateTool(invalidAdd, candidate);
    const invalidMatch =
      oracleInvalid.stdout === candidateInvalid.stdout &&
      oracleInvalid.code === candidateInvalid.code;
    if (!invalidMatch) ok = false;
    results.push({
      op: "add-invalid-cronerror-mapping",
      oracle: oracleInvalid,
      candidate: candidateInvalid,
      match: invalidMatch,
    });

    record("t18-cronjob-tool-roundtrip", ok ? "match" : "DIVERGENT", ok, { results });
  } finally {
    cleanup(oracle);
    cleanup(candidate);
  }
}

// --- Scenario 28: exact tool_error envelopes (assertion 41) ------------------
const ERROR_CASES: { readonly label: string; readonly args: Record<string, unknown> }[] = [
  { label: "unknown-action", args: { action: "frobnicate" } },
  { label: "add-missing-schedule-type", args: { action: "add", name: "n1", prompt: "p1" } },
  { label: "remove-missing-job-id", args: { action: "remove" } },
  { label: "pause-missing-job-id", args: { action: "pause" } },
  { label: "resume-missing-job-id", args: { action: "resume" } },
  { label: "remove-nonexistent", args: { action: "remove", job_id: "ghost" } },
  { label: "pause-nonexistent", args: { action: "pause", job_id: "ghost" } },
];

function scenario28ToolErrorEnvelopes(): void {
  let ok = true;
  const results: unknown[] = [];
  for (const testCase of ERROR_CASES) {
    const oracle = materialize("oracle");
    const candidate = materialize("candidate");
    try {
      const oracleResult = runOracleTool(testCase.args, oracle);
      const candidateResult = runCandidateTool(testCase.args, candidate);
      const match =
        oracleResult.stdout === candidateResult.stdout &&
        oracleResult.code === candidateResult.code;
      if (!match) ok = false;
      results.push({
        label: testCase.label,
        oracle: oracleResult,
        candidate: candidateResult,
        match,
      });
    } finally {
      cleanup(oracle);
      cleanup(candidate);
    }
  }
  record("t18-cronjob-tool-error-envelopes", ok ? "match" : "DIVERGENT", ok, { results });
}

runGuards();
scenario27ToolRoundtrip();
scenario28ToolErrorEnvelopes();

const digestInput = projections
  .toSorted((a, b) => a.id.localeCompare(b.id))
  .map(({ id, sha }) => `${id}=${sha}\n`)
  .join("");
const digest = createHash("sha256").update(digestInput, "utf8").digest("hex");
const result = {
  suite: "t18-cron-tool-bilateral",
  scenarios: projections.length,
  failures,
  localDay: localDay(),
  utcDay: utcDay(),
  digest,
  digestFormula: "sha256(sorted UTF-8 lines id=projectionSha256\\n, trailing newline included)",
  projections,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = failures === 0 && projections.length === 2 ? 0 : 1;
