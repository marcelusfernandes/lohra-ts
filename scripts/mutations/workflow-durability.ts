// T16 mutation harness — external proof on a TEMPORARY git archive of the
// committed candidate SHA (never the working checkout). Issue #149 (passo
// 0b do épico #13): migrado do runner legado de paridade para
// `scripts/mutations/**`, sobre o harness comum de `harness.ts` (#148).
// Os mutantes não mudam — mesmos ids/before/after — só o transporte.
//
// Every focus is run GREEN at baseline before it is run under its mutant
// (`assertBaselineGreen`), and restored green again afterward
// (`assertRestoreGreen`), so a filter that matches no test can never be
// mistaken for a kill.
import { resolve } from "node:path";

import { combinedMutants, guardMutants } from "./workflow-durability-guard.js";
import { namedMutants } from "./workflow-durability-named.js";
import { orchestrationMutants } from "./orchestration.js";
import {
  assertBaselineGreen,
  assertRestoreGreen,
  classify,
  ehEntryPoint,
  prepareArchiveSandbox,
  runFocusedVitest,
  snapshotFiles,
  restoreAll as restoreSnapshot,
  writeReport,
  type RunOutcome,
} from "./harness.js";
import { applyEditExactlyOnce } from "./harness.js";
import type { Focus, Mutant, MutationReport } from "./types.js";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const root = resolve(process.cwd());

export const durabilityMutants: readonly Mutant[] = [
  ...guardMutants,
  ...combinedMutants,
  ...namedMutants,
  ...orchestrationMutants,
];

function focusKey(focus: Focus): string {
  return `${focus.file}::${focus.test}`;
}

interface DurabilityMutationReport extends MutationReport {
  readonly proof: string;
  readonly baselines: readonly { readonly focus: string; readonly ranTests: number }[];
  readonly mutants: readonly {
    readonly id: string;
    readonly category: string;
    readonly mechanism: string;
    readonly focus: Focus;
    readonly baselineRanTests: number;
    readonly ranTests: number;
    readonly killed: boolean;
    readonly killedBy: readonly string[];
    readonly files: readonly string[];
  }[];
  readonly restore: readonly { readonly focus: string; readonly green: boolean }[];
}

export function main(): void {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (head.status !== 0) throw new Error("cannot resolve candidate HEAD");
  const candidateSha = head.stdout.trim();

  const sandbox = prepareArchiveSandbox(root, candidateSha);
  try {
    const files = [...new Set(durabilityMutants.flatMap((m) => m.edits.map((e) => e.file)))];
    const snapshot = snapshotFiles(sandbox, files);
    const restoreAll = (): void => {
      restoreSnapshot(sandbox, snapshot);
    };

    const baselines = new Map<string, RunOutcome>();
    for (const mutant of durabilityMutants) {
      const key = focusKey(mutant.focus);
      if (baselines.has(key)) continue;
      const outcome = runFocusedVitest(sandbox, mutant.focus);
      assertBaselineGreen(outcome, `baseline for focus ${key}`);
      baselines.set(key, outcome);
    }

    const results = durabilityMutants.map((mutant) => {
      restoreAll();
      for (const edit of mutant.edits) applyEditExactlyOnce(sandbox, edit, mutant.id);
      const outcome = runFocusedVitest(sandbox, mutant.focus);
      const key = focusKey(mutant.focus);
      return {
        id: mutant.id,
        category: mutant.category,
        mechanism: mutant.mechanism,
        focus: mutant.focus,
        baselineRanTests: baselines.get(key)?.ranTests ?? 0,
        ranTests: outcome.ranTests,
        killed: classify(outcome.exitCode, outcome.failedTests),
        killedBy: outcome.failedTests,
        files: mutant.edits.map((edit) => edit.file).sort(),
      };
    });

    restoreAll();
    const restore = [...baselines.keys()].map((key) => {
      const [file, test] = key.split("::");
      const outcome = runFocusedVitest(sandbox, { file: file as string, test: test as string });
      return { focus: key, green: assertRestoreGreen(outcome) };
    });

    const survivors = results.filter((result) => !result.killed).map((result) => result.id);
    const restoreGreen = restore.every((entry) => entry.green);
    const evidence: DurabilityMutationReport = {
      suite: "t16-workflow-mutations",
      candidateSha,
      proof: "baseline green per focus -> mutant red on that focus -> restore green",
      baselines: [...baselines.entries()].map(([focus, outcome]) => ({
        focus,
        ranTests: outcome.ranTests,
      })),
      mutants: results,
      killed: results.length - survivors.length,
      total: results.length,
      byCategory: Object.fromEntries(
        [...new Set(results.map((result) => result.category))]
          .sort()
          .map((category) => [
            category,
            results.filter((result) => result.category === category).length,
          ]),
      ),
      survivors,
      restore,
      restoreGreen,
    };
    const evidenceDirectory = resolve(root, ".mutation-evidence/t16");
    writeReport(evidenceDirectory, evidence);
    process.stdout.write(
      `${JSON.stringify({
        suite: evidence.suite,
        candidateSha,
        killed: evidence.killed,
        total: evidence.total,
        byCategory: evidence.byCategory,
        survivors,
        restoreGreen,
        evidence: resolve(evidenceDirectory, "mutations.json"),
      })}\n`,
    );
    process.exitCode = survivors.length === 0 && restoreGreen ? 0 : 1;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (ehEntryPoint(import.meta.url)) main();
