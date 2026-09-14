// Runner de mutação dos 11 mutantes de `src/doctor/**` e
// `src/commands/provider-detectado.ts` (issue #636). Molde de
// `self-update.ts`: único sandbox de `git archive` (via
// `prepareArchiveSandbox` do harness comum), um mutante de cada vez com
// `applyEditExactlyOnce`/`restoreAll`, classificado com `classify`, relatado
// com `writeReport`.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyEditExactlyOnce,
  assertBaselineGreen,
  assertRestoreGreen,
  classify,
  ehEntryPoint,
  prepareArchiveSandbox,
  restoreAll,
  runFocusedVitest,
  snapshotFiles,
  writeReport,
} from "./harness.js";
import { doctorMutants } from "./doctor-mutants.js";
import type { Focus, MutantResult, MutationReport } from "./types.js";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const evidenceDirectory = resolve(root, ".mutation-evidence/doctor");
const suite = "doctor-mutations";

function resolveCandidateSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git rev-parse HEAD failed (exit ${String(result.status)}): ${result.stderr}`);
  return result.stdout.trim();
}

function focusKeyOf(focus: Focus): string {
  return `${focus.file}::${focus.test}`;
}

function runAllMutants(sandbox: string): {
  readonly results: readonly MutantResult[];
  readonly restoreGreen: boolean;
} {
  const files = [
    ...new Set(doctorMutants.flatMap((mutant) => mutant.edits.map((edit) => edit.file))),
  ];
  const originals = snapshotFiles(sandbox, files);

  // Guarda o próprio `Focus` (não só a chave): reconstruir `{file, test}` a
  // partir de `key.split("::")` seria frágil se um título de teste algum
  // dia contivesse o separador.
  const uniqueFoci = new Map<string, Focus>();
  for (const mutant of doctorMutants) uniqueFoci.set(focusKeyOf(mutant.focus), mutant.focus);

  for (const [key, focus] of uniqueFoci) {
    assertBaselineGreen(runFocusedVitest(sandbox, focus), key);
  }

  const results: MutantResult[] = [];
  for (const mutant of doctorMutants) {
    restoreAll(sandbox, originals);
    for (const edit of mutant.edits) applyEditExactlyOnce(sandbox, edit, mutant.id);
    const outcome = runFocusedVitest(sandbox, mutant.focus);
    const killed = outcome.ranTests > 0 && classify(outcome.exitCode, outcome.failedTests);
    results.push({
      id: mutant.id,
      category: mutant.category,
      killed,
      killedBy: outcome.failedTests,
      files: [...new Set(mutant.edits.map((edit) => edit.file))].sort(),
    });
  }

  restoreAll(sandbox, originals);
  const restoreGreen = [...uniqueFoci.values()].every((focus) =>
    assertRestoreGreen(runFocusedVitest(sandbox, focus)),
  );

  return { results, restoreGreen };
}

function buildReport(
  candidateSha: string,
  results: readonly MutantResult[],
  restoreGreen: boolean,
): MutationReport {
  const survivors = results.filter((result) => !result.killed).map((result) => result.id);
  const byCategory: Record<string, number> = {};
  for (const result of results) {
    if (result.category === undefined) continue;
    byCategory[result.category] = (byCategory[result.category] ?? 0) + (result.killed ? 1 : 0);
  }
  return {
    suite,
    candidateSha,
    killed: results.length - survivors.length,
    total: results.length,
    survivors,
    restoreGreen,
    byCategory,
    mutants: results,
  };
}

export function main(): MutationReport {
  const candidateSha = resolveCandidateSha();
  const sandbox = prepareArchiveSandbox(root, candidateSha);
  try {
    const { results, restoreGreen } = runAllMutants(sandbox);
    const report = buildReport(candidateSha, results, restoreGreen);
    writeReport(evidenceDirectory, report);
    return report;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (ehEntryPoint(import.meta.url)) {
  try {
    const report = main();
    if (report.survivors.length > 0 || !report.restoreGreen) {
      console.error(JSON.stringify(report));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(report));
    }
  } catch (cause) {
    console.error(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
    process.exitCode = 1;
  }
}
