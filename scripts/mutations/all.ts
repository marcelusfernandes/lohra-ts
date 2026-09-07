// scripts/mutations/all.ts — agregador único de mutação (issue #155, passo
// 11 de `orquestracao.md`). Lê `slices.json`, roda cada `script` DUAS vezes
// por subprocesso (`npm run <script>` — nunca por import: cinco dos seis
// runners chamam `main()` incondicionalmente ao serem importados, `#186`
// corrige isso em paralelo em `scripts/mutations/**`), agrega
// `{slice, killed, total, survivors, digest}` por fatia e escreve
// `.mutation-evidence/all.json`. Falha (`process.exitCode = 1`) nomeando a
// fatia e o id do sobrevivente se um aparecer em qualquer corrida, ou se
// `restoreGreen` vier `false`; falha com `MUTATION_NONDETERMINISTIC:<fatia>`
// se os digests das duas corridas da mesma fatia divergirem — a mesma
// mecânica do agregador de closeout T22 hoje aposentado (issue #153; o
// histórico de `git log` do commit `e55d540~1` guarda a implementação
// original, linhas 476-510), portada sem o diretório de closeout T22 e sem
// `--t22-only`. `scripts/mutations/**` não referencia o diretório histórico
// de paridade por literal (`tests/mutations-directory-pin.test.ts`, #178).
//
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256 } from "./canonical.js";

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Os dois únicos campos de cada entrada de `slices.json` que este
 * agregador usa — o schema completo já é provado por
 * `tests/mutations-slices.test.ts` (#154). */
export interface SliceConfig {
  readonly slice: string;
  readonly script: string;
}

/** Uma corrida de subprocesso (`npm run <script>`), antes de qualquer
 * interpretação. */
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** O mínimo comum de `MutationReport` (`types.ts`) que os seis runners já
 * emitem — validado aqui como boundary de I/O não confiável (saída de
 * subprocesso, CLAUDE.md "validar em toda borda"). */
export interface ParsedSliceReport {
  readonly suite: string;
  readonly candidateSha: string;
  readonly killed: number;
  readonly total: number;
  readonly survivors: readonly string[];
  readonly restoreGreen: boolean;
}

/** O veredito de uma fatia depois das duas corridas: o relatório (de
 * qualquer uma das duas, já que precisam ser idênticas) mais o `digest`
 * comum. */
export interface SliceOutcome extends ParsedSliceReport {
  readonly slice: string;
  readonly script: string;
  readonly digest: string;
}

/** `.mutation-evidence/all.json`. */
export interface AllMutationsReport {
  readonly candidateSha: string;
  readonly slices: readonly SliceOutcome[];
}

const ROOT = resolve(import.meta.dirname, "../..");
const SLICES_PATH = resolve(ROOT, "scripts/mutations/slices.json");
const EVIDENCE_PATH = resolve(ROOT, ".mutation-evidence/all.json");
const RUN_TIMEOUT_MS = 20 * 60_000;

/** Lê e valida `scripts/mutations/slices.json` (ou `path`, para teste),
 * extraindo só `slice`/`script`. */
export function readSliceConfigs(path: string = SLICES_PATH): readonly SliceConfig[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path}: esperava um array no topo`);
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null)
      throw new Error(`${path}[${String(index)}]: esperava um objeto`);
    const candidate = entry as Record<string, unknown>;
    const { slice, script } = candidate;
    if (typeof slice !== "string" || slice === "")
      throw new Error(`${path}[${String(index)}]: "slice" precisa ser string não-vazia`);
    if (typeof script !== "string" || script === "")
      throw new Error(`${path}[${String(index)}] (${slice}): "script" precisa ser string`);
    return { slice, script };
  });
}

/** Extrai a última linha de `output` que parece um objeto JSON completo
 * (`{...}`) — o contrato que todo runner de `scripts/mutations/*.ts` já
 * respeita (comentário em `workflow-audit-live.ts`: "o consumidor legado
 * histórico... lê a última linha de stdout que começa com `{` e termina
 * com `}`"). Lança se nenhuma linha bater. */
export function extractJsonLine(output: string, context: string): string {
  const line = output
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("{") && value.endsWith("}"))
    .at(-1);
  if (line === undefined) throw new Error(`MUTATION_ALL_NO_REPORT:${context}`);
  return line;
}

/** Valida o shape mínimo de `ParsedSliceReport` a partir de uma linha JSON
 * já extraída. */
export function parseSliceReport(line: string, context: string): ParsedSliceReport {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`MUTATION_ALL_BAD_REPORT:${context}`);
  const candidate = parsed as Record<string, unknown>;
  const { suite, candidateSha, killed, total, survivors, restoreGreen } = candidate;
  if (typeof suite !== "string") throw new Error(`MUTATION_ALL_BAD_REPORT:${context}:suite`);
  if (typeof candidateSha !== "string")
    throw new Error(`MUTATION_ALL_BAD_REPORT:${context}:candidateSha`);
  if (typeof killed !== "number") throw new Error(`MUTATION_ALL_BAD_REPORT:${context}:killed`);
  if (typeof total !== "number") throw new Error(`MUTATION_ALL_BAD_REPORT:${context}:total`);
  if (!isStringArray(survivors)) throw new Error(`MUTATION_ALL_BAD_REPORT:${context}:survivors`);
  if (typeof restoreGreen !== "boolean")
    throw new Error(`MUTATION_ALL_BAD_REPORT:${context}:restoreGreen`);
  return { suite, candidateSha, killed, total, survivors, restoreGreen };
}

/** Reduz uma corrida bruta ao relatório interpretado e ao digest
 * determinístico (sha256 da linha JSON bruta — não uma reserialização, para
 * que reordenar chaves no runner nunca esconda não-determinismo real). */
export function evaluateRun(
  run: RunResult,
  context: string,
): { readonly report: ParsedSliceReport; readonly digest: string } {
  const line = extractJsonLine(`${run.stdout}\n${run.stderr}`, context);
  return { report: parseSliceReport(line, context), digest: sha256(line) };
}

/** Lança se `report` tem sobrevivente ou se `restoreGreen` veio `false` —
 * fault com causa, nunca silenciosa (CLAUDE.md, invariante 2). */
function assertRunClean(report: ParsedSliceReport, slice: string): void {
  if (report.survivors.length > 0) {
    const [survivorId] = report.survivors;
    throw new Error(`MUTATION_SURVIVOR:${slice}:${String(survivorId)}`);
  }
  if (!report.restoreGreen) throw new Error(`MUTATION_RESTORE_NOT_GREEN:${slice}`);
}

/** Roda `slice.script` até duas vezes via `execute`: a segunda corrida só
 * acontece se a primeira já não tiver reprovado (sobrevivente ou
 * `restoreGreen` falso) — sem isso, uma fatia com sobrevivente óbvio pagaria
 * duas corridas de até 20 minutos cada por nada (CLAUDE.md invariante 3,
 * "budget nunca unbounded"). */
export function runSliceTwice(
  slice: SliceConfig,
  execute: (script: string) => RunResult,
): SliceOutcome {
  const first = evaluateRun(execute(slice.script), slice.slice);
  assertRunClean(first.report, slice.slice);

  const second = evaluateRun(execute(slice.script), slice.slice);
  assertRunClean(second.report, slice.slice);

  if (first.digest !== second.digest) throw new Error(`MUTATION_NONDETERMINISTIC:${slice.slice}`);

  return {
    slice: slice.slice,
    script: slice.script,
    ...first.report,
    digest: first.digest,
  };
}

/** Roda todas as fatias, em ordem, parando na primeira que falhar
 * (`Array.prototype.map` propaga a exceção do primeiro `runSliceTwice`
 * malsucedido — nunca "budget unbounded", CLAUDE.md invariante 3). */
export function runAllSlices(
  slices: readonly SliceConfig[],
  execute: (script: string) => RunResult,
): readonly SliceOutcome[] {
  return slices.map((slice) => runSliceTwice(slice, execute));
}

/** Agrega os vereditos por fatia no relatório final. Lança se a lista vier
 * vazia, ou se alguma fatia relatar um `candidateSha` diferente da
 * primeira (sinal de que o código mudou no meio da corrida). */
export function buildReport(slices: readonly SliceOutcome[]): AllMutationsReport {
  const [first] = slices;
  if (first === undefined) throw new Error("MUTATION_ALL_EMPTY_SLICES");
  for (const outcome of slices) {
    if (outcome.candidateSha !== first.candidateSha)
      throw new Error(`MUTATION_ALL_SHA_MISMATCH:${outcome.slice}`);
  }
  return { candidateSha: first.candidateSha, slices };
}

/** Escreve `report` em `path` (default `.mutation-evidence/all.json`), em
 * JSON canônico (`canonicalJson`). */
export function writeAllEvidence(report: AllMutationsReport, path: string = EVIDENCE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalJson(report), "utf8");
}

function realExecute(script: string): RunResult {
  const result = spawnSync("npm", ["run", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function main(): AllMutationsReport {
  const slices = readSliceConfigs();
  const outcomes = runAllSlices(slices, realExecute);
  const report = buildReport(outcomes);
  writeAllEvidence(report);
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = main();
    console.log(JSON.stringify(report));
  } catch (cause) {
    console.error(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
    process.exitCode = 1;
  }
}
