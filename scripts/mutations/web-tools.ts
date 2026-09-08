// Runner de mutação de `src/web/**` (issue #152, passo 0e do épico #13).
// Migra os 9 mutantes do runner de paridade aposentado desta área para o
// harness comum (`scripts/mutations/harness.ts`, issue #148): mecânica A
// (git archive do HEAD + vitest focado). Sem oráculo externo: nenhuma
// resolução de workspace Python, nenhuma execução de cenário bilateral por
// manifesto, nenhum manifesto do oráculo aposentado, e sem compilar o
// sandbox no caminho de morte. O oráculo de morte passa a ser inteiramente
// TypeScript: cada mutante precisa deixar vermelho um teste já existente (ou
// novo, `test(red):`) em `tests/web-*.test.ts`. O catálogo em si mora em
// `web-tools-mutants.ts` (módulo de dados puro, sem efeito colateral no
// import) para que `tests/mutations-t20-catalog.test.ts` possa pinar cada
// `before` sem pagar o custo de rodar este runner.
//
// Prova: baseline verde por foco -> mutante vermelho nesse foco -> restore
// verde (o mesmo desenho do runner de paridade aposentado de
// workflow-durability, só que sobre o harness comum em vez de reimplementar
// archive/restore).
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
import type { Focus, MutationReport } from "./types.js";
import { webToolsMutants } from "./web-tools-mutants.js";

const root = resolve(import.meta.dirname, "../..");
const evidenceDirectory = resolve(root, ".mutation-evidence/t20");

function headSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("cannot resolve candidate HEAD");
  return result.stdout.trim();
}

function focusKey(focus: Focus): string {
  return `${focus.file}::${focus.test}`;
}

/**
 * Garante que o foco roda pelo menos um teste e sai verde ANTES da mutação.
 * Sem isso, um foco obsoleto (padrão `-t` que não casa com teste nenhum)
 * sairia com `exitCode: 0` e `ranTests: 0`, e `classify` leria isso como um
 * sobrevivente silencioso, não como o setup quebrado que é de fato. O
 * harness comum (issue #148, PR #170) não oferece este helper — o revisor
 * anotou a lacuna e pediu que cada runner migrado o resolvesse por conta
 * própria; aqui os focos são todos novos (não herdados de outro runner), daí
 * a guarda ser especialmente relevante.
 */
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
      ...new Set(webToolsMutants.flatMap((mutant) => mutant.edits.map((edit) => edit.file))),
    ];
    const snapshot = snapshotFiles(sandbox, files);

    const foci = new Map<string, Focus>();
    for (const mutant of webToolsMutants) foci.set(focusKey(mutant.focus), mutant.focus);
    for (const focus of foci.values()) assertBaselineGreen(sandbox, focus);

    const results = webToolsMutants.map((mutant) => {
      restoreAll(sandbox, snapshot);
      for (const edit of mutant.edits) applyEditExactlyOnce(sandbox, edit, mutant.id);
      const outcome = runFocusedVitest(sandbox, mutant.focus);
      // `runFocusedVitest` lança se o vitest não produzir JSON (harness.ts,
      // `parseVitestOutcome` — fail-closed, não devolve mais um sentinela).
      // A guarda abaixo cobre o caso que ainda passa por JSON válido: um
      // foco que, pós-mutação, deixou de coletar teste nenhum
      // (`ranTests: 0`). `assertBaselineGreen` já cobriu o lado
      // pré-mutação; aqui, do lado pós-mutação, esse foco nunca conta como
      // morto.
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
      suite: "t20-web-tools-mutations",
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
