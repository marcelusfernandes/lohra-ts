// T15 mutation harness — external proof on a TEMPORARY git archive of the
// committed candidate SHA (never the working checkout). Issue #149 (passo
// 0b do épico #13): migrado do runner legado de paridade para
// `scripts/mutations/**`, sobre o harness comum de `harness.ts` (#148).
// Os mutantes não mudam — mesmos ids/before/after — só o transporte.
//
// Ao contrário de t16, t15 não afunila num foco por mutante: a mesma
// bateria de cinco arquivos focais roda inteira para cada um dos 44
// mutantes (`runVitestFiles`, sem `-t`) — é assim que o runner original
// já funcionava, e a issue #149 não muda mutante nenhum. O quinto arquivo
// (`tests/mutations-fixtures-workflow-executor.test.ts`) é NOVO: cobre os
// três mutantes cujo alvo é uma cópia sob `scripts/mutations/fixtures/`
// em vez de `src/**`.
//
// O catálogo (`executorMutants`/`focalTests`) mora em
// `workflow-executor-mutants.ts` desde a issue #186: até então este runner
// era catálogo E runner (chamava `main()` incondicionalmente na avaliação
// do módulo), então importá-lo para contar os 44 mutantes disparava uma
// corrida de mutação real. Com o catálogo extraído para um módulo de dado
// puro, `tests/mutations-slices.test.ts` conta importando, como as outras
// cinco fatias.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

import {
  applyEditExactlyOnce,
  assertBaselineGreen,
  assertRestoreGreen,
  classify,
  ehEntryPoint,
  prepareArchiveSandbox,
  restoreAll as restoreSnapshot,
  runVitestFiles,
  snapshotFiles,
  writeReport,
} from "./harness.js";
import type { MutationReport } from "./types.js";
import { executorMutants, focalTests } from "./workflow-executor-mutants.js";

const root = resolve(process.cwd());

interface ExecutorMutationReport extends MutationReport {
  readonly mutants: readonly {
    readonly id: string;
    readonly mechanism: string;
    readonly killed: boolean;
    readonly ranTests: number;
    readonly killedBy: readonly string[];
    readonly files: readonly string[];
  }[];
}

export function main(): void {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (head.status !== 0) throw new Error("cannot resolve candidate HEAD");
  const candidateSha = head.stdout.trim();

  const sandbox = prepareArchiveSandbox(root, candidateSha);
  try {
    const files = [...new Set(executorMutants.flatMap((m) => m.edits.map((e) => e.file)))];
    const snapshot = snapshotFiles(sandbox, files);
    const restoreAll = (): void => {
      restoreSnapshot(sandbox, snapshot);
    };

    const baseline = runVitestFiles(sandbox, focalTests);
    assertBaselineGreen(baseline, "t15 baseline");

    const results = executorMutants.map((mutant) => {
      restoreAll();
      for (const edit of mutant.edits) applyEditExactlyOnce(sandbox, edit, mutant.id);
      const outcome = runVitestFiles(sandbox, focalTests);
      return {
        id: mutant.id,
        mechanism: mutant.mechanism,
        ranTests: outcome.ranTests,
        killed: classify(outcome.exitCode, outcome.failedTests),
        killedBy: outcome.failedTests,
        files: mutant.edits.map((edit) => edit.file).sort(),
      };
    });

    restoreAll();
    const restored = runVitestFiles(sandbox, focalTests);
    const restoreGreen = assertRestoreGreen(restored);

    const survivors = results.filter((result) => !result.killed).map((result) => result.id);
    const evidence: ExecutorMutationReport = {
      suite: "t15-workflow-mutations",
      candidateSha,
      mutants: results,
      killed: results.length - survivors.length,
      total: results.length,
      survivors,
      restoreGreen,
    };
    const evidenceDirectory = resolve(root, ".mutation-evidence/t15");
    writeReport(evidenceDirectory, evidence);
    process.stdout.write(
      `${JSON.stringify({
        suite: evidence.suite,
        candidateSha,
        killed: evidence.killed,
        total: evidence.total,
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
