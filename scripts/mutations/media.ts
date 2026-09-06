#!/usr/bin/env node
// scripts/mutations/media.ts — migração do runner de mídia (issue #151,
// passo 0d do épico #13; o antigo run-mutations.ts de mídia agora é um
// shim). 20 mutantes declarativos (media-catalog-persistence.ts,
// media-catalog-other.ts) preservam a mecânica B do runner antigo:
// `cpSync(src)` para um diretório descartável + edit exato-uma-vez + import
// dinâmico EM PROCESSO (não subprocesso) + comparador — a família B, fora
// do escopo do harness comum (`harness.ts`, #148 cobriu só a família A:
// sandbox por `git archive` + foco de vitest em subprocesso). Só
// `applyEditExactlyOnce` e `writeReport` vêm de lá; o resto da mecânica B
// (carregar o módulo, decidir killed/restoreGreen) é privado deste
// catálogo.
//
// `restoreGreen`: cada `probe` roda duas vezes — contra o módulo mutado
// (decide `killed`) e contra uma cópia SEM os edits, a "árvore restaurada"
// (decide `restoreGreen`). Sem essa segunda corrida um `probe` cujo
// `actual` nunca bate com `expected` apareceria sempre "killed", mutação
// ou não — o problema que 9 dos 20 oráculos do runner antigo tinham
// (contagem completa, com motivo por id, nos headers de
// media-catalog-persistence.ts e media-catalog-other.ts), de três formas:
// três `probe`s sem tratamento do `throw` no caminho restaurado (crash,
// não silêncio), quatro com uma chave em `expected` que `actual` nunca
// produzia, e dois com dado de teste que nunca convergia independente da
// mutação (canário fora do padrão de redação; checagem de string que o
// transpilador nunca produz literalmente). `out-dir-symlink` (rodada 1 da
// PR #176) mostrou o risco do diagnóstico errado: tratar o sintoma
// (`restoreGreen: false`) como "mutante morto" sem checar se havia sinal
// observável em outro campo — tinha (`error_named`); o defeito era só a
// chave ausente em `expected`, igual às outras três `unsafe-url-*`.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { applyEditExactlyOnce, writeReport } from "./harness.js";
import { otherMediaMutants } from "./media-catalog-other.js";
import { persistenceMutants } from "./media-catalog-persistence.js";
import { compareMediaRows } from "./media-comparator.js";
import type { MediaMutant } from "./media-mutant.js";
import type { Edit, MutationReport } from "./types.js";

export const mediaMutants: readonly MediaMutant[] = Object.freeze([
  ...persistenceMutants,
  ...otherMediaMutants,
]);

const root = resolve(import.meta.dirname, "../..");

interface LoadedModule {
  readonly module: Record<string, unknown>;
  readonly dispose: () => void;
}

/** Copia `src/` inteiro para um diretório descartável, aplica `edits`
 * (vazio = a árvore restaurada) e importa `entry` de dentro dele — a
 * mesma mecânica B do runner antigo, sem tocar o `src/` real. */
async function loadMediaModule(
  cacheBust: string,
  entry: string,
  edits: readonly Edit[],
): Promise<LoadedModule> {
  const runtime = mkdtempSync(join(tmpdir(), "lohra-t21-mutant-"));
  const sourceRoot = join(runtime, "src");
  cpSync(join(root, "src"), sourceRoot, { recursive: true });
  writeFileSync(join(runtime, "package.json"), '{"type":"module"}\n');
  for (const edit of edits) applyEditExactlyOnce(sourceRoot, edit, cacheBust);
  const module = (await import(
    `${pathToFileURL(join(sourceRoot, entry)).href}?mutation=${encodeURIComponent(cacheBust)}`
  )) as Record<string, unknown>;
  return {
    module,
    dispose: () => {
      rmSync(runtime, { recursive: true, force: true });
    },
  };
}

function candidateSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("git rev-parse HEAD failed");
  return result.stdout.trim();
}

interface MutantOutcome {
  readonly id: string;
  readonly category: string;
  readonly killed: boolean;
  readonly observation: string;
  readonly restoreGreen: boolean;
}

/** `mutant.probe` está errado (não do jeito que ele detecta a mutação) se
 * lançar fora do caminho que ele mesmo desenha — falha alto, com a causa,
 * em vez de deixar uma rejeição sem tratamento não identificar qual
 * mutante quebrou. */
async function probeOrFail(mutant: MediaMutant, module: Record<string, unknown>): Promise<unknown> {
  try {
    return await mutant.probe(module);
  } catch (cause) {
    throw new Error(`${mutant.id}: probe threw`, { cause });
  }
}

async function evaluate(mutant: MediaMutant): Promise<MutantOutcome> {
  const mutated = await loadMediaModule(mutant.id, mutant.entry, mutant.edits);
  let mutatedActual: unknown;
  try {
    mutatedActual = await probeOrFail(mutant, mutated.module);
  } finally {
    mutated.dispose();
  }

  const baseline = await loadMediaModule(`${mutant.id}-baseline`, mutant.entry, []);
  let baselineActual: unknown;
  try {
    baselineActual = await probeOrFail(mutant, baseline.module);
  } finally {
    baseline.dispose();
  }

  const [mutatedComparison] = compareMediaRows(
    [{ id: mutant.id, value: mutant.expected }],
    [{ id: mutant.id, value: mutatedActual }],
  );
  const [baselineComparison] = compareMediaRows(
    [{ id: mutant.id, value: mutant.expected }],
    [{ id: mutant.id, value: baselineActual }],
  );

  return {
    id: mutant.id,
    category: mutant.category,
    killed: mutatedComparison?.pass === false,
    observation: mutatedComparison?.reason ?? "mutant normalized to match",
    restoreGreen: baselineComparison?.pass === true,
  };
}

function byCategory(outcomes: readonly MutantOutcome[]): Record<string, number> {
  const categories = [...new Set(outcomes.map((outcome) => outcome.category))].sort();
  return Object.fromEntries(
    categories.map((category) => [
      category,
      outcomes.filter((outcome) => outcome.category === category).length,
    ]),
  );
}

export async function runMediaMutations(): Promise<
  MutationReport & { readonly results: readonly MutantOutcome[]; readonly evidence: string }
> {
  const outcomes: MutantOutcome[] = [];
  for (const mutant of mediaMutants) outcomes.push(await evaluate(mutant));

  const survivors = outcomes.filter((outcome) => !outcome.killed).map((outcome) => outcome.id);
  const report = {
    suite: "t21-mutations",
    candidateSha: candidateSha(),
    killed: outcomes.length - survivors.length,
    total: outcomes.length,
    survivors,
    restoreGreen: outcomes.every((outcome) => outcome.restoreGreen),
    byCategory: byCategory(outcomes),
    results: outcomes,
  };
  const evidenceDirectory = resolve(root, ".mutation-evidence/t21");
  writeReport(evidenceDirectory, report);
  return { ...report, evidence: join(evidenceDirectory, "mutations.json") };
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1])) {
  const outcome = await runMediaMutations();
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exitCode = outcome.survivors.length > 0 || !outcome.restoreGreen ? 1 : 0;
}
