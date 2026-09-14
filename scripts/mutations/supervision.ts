// Runner de mutação da fatia `supervision` (issue #451, milestone 14):
// código novo de M10 (steer, leaf_read, route-faults, route-override,
// dead_turn) que `npm run mutations:all` deixava sem nenhum mutante
// dedicado — molde `scripts/mutations/web-tools.ts` (issue #152), mesma
// mecânica A (`harness.ts`, issue #148): git archive do HEAD + vitest
// focado por mutante, catálogo em `supervision-mutants.ts` (módulo de dados
// puro, sem efeito colateral no import).
//
// Prova: baseline verde por foco -> mutante vermelho nesse foco -> restore
// verde.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  applyEditExactlyOnce,
  classify,
  ehEntryPoint,
  prepareArchiveSandbox,
  restoreAll,
  runFocusedVitest,
  snapshotFiles,
  writeReport,
} from "./harness.js";
import type { Focus, Mutant, MutationReport } from "./types.js";
import { supervisionMutants } from "./supervision-mutants.js";
import { supervisionMutants2 } from "./supervision-mutants-2.js";

const root = resolve(import.meta.dirname, "../..");

// Issue #647 (grupo A de #637, item 6): o runner concatena os dois
// catálogos da fatia `supervision` — `supervision-mutants-2.ts` vive num
// arquivo separado (o `Files` da issue não autoriza crescer
// `supervision-mutants.ts` além do teto de 800 linhas), mas roda na mesma
// corrida de `npm run mutations:supervision` (mesmo padrão de
// `context-window.ts`/`context-prompt-mutants.ts`, issue #646).
const allMutants: readonly Mutant[] = [...supervisionMutants, ...supervisionMutants2];
const evidenceDirectory = resolve(root, ".mutation-evidence/supervision");

function headSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("cannot resolve candidate HEAD");
  return result.stdout.trim();
}

function focusKey(focus: Focus): string {
  return `${focus.file}::${focus.test}`;
}

/** Garante que o foco roda pelo menos um teste e sai verde ANTES da
 * mutação — mesma guarda que `web-tools.ts` acrescentou (issue #152): sem
 * ela, um `-t` obsoleto que não bate teste nenhum sairia `{exitCode: 0,
 * ranTests: 0}` e `classify` leria isso como sobrevivente silencioso. */
function assertBaselineGreen(directory: string, focus: Focus): void {
  const outcome = runFocusedVitest(directory, focus);
  if (outcome.exitCode !== 0 || outcome.ranTests === 0) {
    throw new Error(
      `baseline for focus ${focusKey(focus)} is not green with tests ` +
        `(exit=${String(outcome.exitCode)}, ran=${String(outcome.ranTests)})`,
    );
  }
}

export function main(): void {
  const candidateSha = headSha();
  const sandbox = prepareArchiveSandbox(root, candidateSha);
  try {
    const files = [
      ...new Set(allMutants.flatMap((mutant) => mutant.edits.map((edit) => edit.file))),
    ];
    const snapshot = snapshotFiles(sandbox, files);

    const foci = new Map<string, Focus>();
    for (const mutant of allMutants) foci.set(focusKey(mutant.focus), mutant.focus);
    for (const focus of foci.values()) assertBaselineGreen(sandbox, focus);

    const results = allMutants.map((mutant) => {
      restoreAll(sandbox, snapshot);
      for (const edit of mutant.edits) applyEditExactlyOnce(sandbox, edit, mutant.id);
      const outcome = runFocusedVitest(sandbox, mutant.focus);
      const killed = outcome.ranTests > 0 && classify(outcome.exitCode, outcome.failedTests);
      return {
        id: mutant.id,
        category: mutant.category,
        mechanism: mutant.mechanism,
        focus: mutant.focus,
        ranTests: outcome.ranTests,
        killed,
        killedBy: outcome.failedTests,
        files: [...new Set(mutant.edits.map((edit) => edit.file))].sort(),
      };
    });

    restoreAll(sandbox, snapshot);
    const restored = [...foci.entries()].map(([key, focus]) => {
      const outcome = runFocusedVitest(sandbox, focus);
      return { focus: key, green: outcome.exitCode === 0 && outcome.ranTests > 0 };
    });
    const restoreGreen = restored.every((entry) => entry.green);

    const survivors = results.filter((result) => !result.killed).map((result) => result.id);
    const byCategory = Object.fromEntries(
      [...new Set(results.map((result) => result.category))]
        .sort()
        .map((category) => [
          category,
          results.filter((result) => result.category === category).length,
        ]),
    );
    const report: MutationReport = {
      suite: "supervision-mutations",
      candidateSha,
      killed: results.length - survivors.length,
      total: results.length,
      survivors,
      restoreGreen,
      byCategory,
    };
    writeReport(evidenceDirectory, report);
    process.stdout.write(
      `${JSON.stringify({
        suite: report.suite,
        candidateSha,
        killed: report.killed,
        total: report.total,
        byCategory,
        survivors,
        restoreGreen,
        mutants: results,
        evidence: resolve(evidenceDirectory, "mutations.json"),
      })}\n`,
    );
    process.exitCode = survivors.length === 0 && restoreGreen ? 0 : 1;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (ehEntryPoint(import.meta.url)) main();
