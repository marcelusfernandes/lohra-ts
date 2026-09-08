// Runner de mutação de `src/workflow/audit-*` e vizinhos (issue #150, passo
// 13-S3 do épico #13). Substitui o antigo runner de mutação de
// workflow-audit-live no diretório histórico de paridade: um único sandbox
// de `git archive` (via `prepareArchiveSandbox` do harness comum), 32
// mutantes aplicados um de cada vez com `applyEditExactlyOnce`/`restoreAll`,
// classificados com `classify`, relatados com `writeReport`. Sem o SHA do
// oracle Python hardcoded, sem os binários de sistema absolutos nem a
// dependência do diretório histórico de paridade que o runner antigo tinha.
//
// Dois helpers locais que ainda não existem em `scripts/mutations/harness.ts`
// (issue #149 está adicionando esses mesmos helpers ao harness comum —
// quando #149 mergear, migrar `assertBaselineGreen`/`isKilled` para lá e
// apagar as cópias daqui):
//
//   - `assertBaselineGreen`: um foco cujo `-t` não bate com nenhum teste
//     (`ranTests === 0`) é ambíguo — nunca deveria acontecer antes de
//     qualquer edit ser aplicado. Se acontecer, é o catálogo que está
//     desatualizado (`focus.test` não existe mais), não um mutante morto.
//     Lança em vez de deixar o mutante virar sobrevivente calado.
//   - `isKilled`: o sentinela `"<no json report>"` do harness
//     (`parseVitestOutcome`) aparece com `ranTests: 0` quando o vitest
//     não produziu relatório JSON (por exemplo, colapso de coleta). Sem a
//     guarda `ranTests > 0`, esse sentinela teria `failedTests.length > 0`
//     e um `exitCode` não-zero contariam como "killed" por acidente do
//     parser, não porque o teste focal realmente falhou.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyEditExactlyOnce,
  classify,
  ehEntryPoint,
  prepareArchiveSandbox,
  restoreAll,
  runFocusedVitest,
  snapshotFiles,
  writeReport,
  type RunOutcome,
} from "./harness.js";
import type { Focus, MutationReport } from "./types.js";
import { mutants } from "./workflow-audit-live-mutants.js";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const evidenceDir = resolve(root, ".mutation-evidence/t17");
const suite = "t17-workflow-audit-live";

function resolveCandidateSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git rev-parse HEAD failed (exit ${String(result.status)}): ${result.stderr}`);
  return result.stdout.trim();
}

/** TODO(#149): migrar para `scripts/mutations/harness.ts` quando o helper
 * comum existir lá (veredito da PR #170). */
function assertBaselineGreen(outcome: RunOutcome, focusKey: string): void {
  if (outcome.exitCode !== 0 || outcome.ranTests === 0)
    throw new Error(
      `baseline for focus ${focusKey} is not green with tests ` +
        `(exit=${String(outcome.exitCode)}, ran=${String(outcome.ranTests)})`,
    );
}

/** TODO(#149): migrar para `scripts/mutations/harness.ts` quando o helper
 * comum existir lá (veredito da PR #170: sentinela `<no json report>` não
 * pode virar `killed`). */
function isKilled(outcome: RunOutcome): boolean {
  return outcome.ranTests > 0 && classify(outcome.exitCode, outcome.failedTests);
}

function focusKeyOf(focus: Focus): string {
  return `${focus.file}::${focus.test}`;
}

interface MutantResult {
  readonly id: string;
  readonly category: string;
  readonly killed: boolean;
}

function runAllMutants(sandbox: string): {
  readonly results: readonly MutantResult[];
  readonly restoreGreen: boolean;
} {
  const files = Array.from(new Set(mutants.flatMap((mutant) => mutant.edits.map((e) => e.file))));
  const originals = snapshotFiles(sandbox, files);

  // Guarda o próprio `Focus` (não só a chave) — reconstruir `{file, test}`
  // a partir de `key.split("::")` seria frágil se um título de teste algum
  // dia contivesse o separador, e exigiria um fallback silencioso para
  // suíte inteira quando a chave não tivesse o formato esperado.
  const uniqueFoci = new Map<string, Focus>();
  for (const mutant of mutants) uniqueFoci.set(focusKeyOf(mutant.focus), mutant.focus);

  for (const [key, focus] of uniqueFoci) {
    assertBaselineGreen(runFocusedVitest(sandbox, focus), key);
  }

  const results: MutantResult[] = [];
  for (const mutant of mutants) {
    restoreAll(sandbox, originals);
    for (const edit of mutant.edits) applyEditExactlyOnce(sandbox, edit, mutant.id);
    const outcome = runFocusedVitest(sandbox, mutant.focus);
    results.push({ id: mutant.id, category: mutant.category, killed: isKilled(outcome) });
  }

  restoreAll(sandbox, originals);
  const restoreGreen = Array.from(uniqueFoci.values()).every((focus) => {
    const outcome = runFocusedVitest(sandbox, focus);
    return outcome.exitCode === 0 && outcome.ranTests > 0;
  });

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
    if (!result.killed) continue;
    byCategory[result.category] = (byCategory[result.category] ?? 0) + 1;
  }
  return {
    suite,
    candidateSha,
    killed: results.length - survivors.length,
    total: results.length,
    survivors,
    restoreGreen,
    byCategory,
  };
}

export function main(): MutationReport {
  const candidateSha = resolveCandidateSha();
  const sandbox = prepareArchiveSandbox(root, candidateSha);
  try {
    const { results, restoreGreen } = runAllMutants(sandbox);
    const report = buildReport(candidateSha, results, restoreGreen);
    writeReport(evidenceDir, report);
    return report;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (ehEntryPoint(import.meta.url)) {
  try {
    const report = main();
    // Uma linha só (não `canonicalJson`, que é multilinha): o consumidor
    // legado histórico de `mutations:*` (fora de escopo desta issue) lê a
    // última linha de stdout que começa com `{` e termina com `}`. O arquivo
    // de evidência continua canônico.
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
