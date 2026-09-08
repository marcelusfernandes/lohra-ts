// scripts/mutations/all.ts — agregador único de mutação (issue #155, passo
// 11 de `orquestracao.md`). Lê `slices.json`, roda cada `script` até duas
// vezes por subprocesso (`npm run <script>` — nunca por import: cinco dos
// seis runners chamam `main()` incondicionalmente ao serem importados,
// `#186` corrige isso em paralelo em `scripts/mutations/**`); a segunda
// corrida só acontece se a primeira não reprovar (`runSliceTwice` abaixo).
// Agrega `{slice, killed, total, survivors, digest}` por fatia e escreve
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
// Diagnóstico do subprocesso (issue #196, achados 1-3 do revisor da PR #194):
// `realExecute` nunca lança — devolve sempre `{status, signal, stdout,
// stderr, error?}`, e é `evaluateRun` quem nomeia a causa: timeout do
// `spawnSync` (`error.code === "ETIMEDOUT"`) vira `MUTATION_ALL_TIMEOUT:<fatia>`;
// processo morto por sinal sem timeout (`signal !== null`, sem `error`) vira
// `MUTATION_ALL_KILLED:<fatia>:<sinal>`; e um relatório que sai limpo mas cujo
// processo termina com `status !== 0` (runner que imprime e morre depois,
// `finally`/unhandled rejection) vira `MUTATION_ALL_EXIT:<fatia>:<status>` em
// vez de passar como verde. `realExecute` aceita `{cwd, timeoutMs}` opcionais
// só para teste (`tests/mutations-all.test.ts` spawna scripts falsos num
// diretório temporário com timeout curto); em produção usam sempre `ROOT` e
// `RUN_TIMEOUT_MS`. O caminho de `scripts/mutations/slices.json` também pode
// ser trocado por teste via a variável de ambiente `MUTATIONS_ALL_SLICES_PATH`
// (relativa a `ROOT` ou absoluta) — é o que o teste de entrypoint em
// subprocesso usa para apontar `mutations:all` para uma fatia falsa sem
// tocar `package.json` nem `scripts/mutations/slices.json` de verdade.
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
 * interpretação. `signal` é `null` quando o processo saiu por conta própria
 * (mesmo que com `status !== 0`); `error` só existe quando o próprio
 * `spawnSync` falhou em rodar ou aguardar o processo (timeout incluso —
 * `error.code === "ETIMEDOUT"`, ver `evaluateRun`). */
export interface RunResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
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
const SLICES_PATH_DEFAULT = resolve(ROOT, "scripts/mutations/slices.json");
const EVIDENCE_PATH = resolve(ROOT, ".mutation-evidence/all.json");
const RUN_TIMEOUT_MS = 20 * 60_000;

/** `scripts/mutations/slices.json`, ou o override de
 * `MUTATIONS_ALL_SLICES_PATH` (relativo a `ROOT`, ou absoluto) — só para o
 * teste do entrypoint em subprocesso (issue #196); `main()` não recebe outro
 * caminho. */
function resolveSlicesPath(): string {
  const override = process.env["MUTATIONS_ALL_SLICES_PATH"];
  if (override === undefined || override === "") return SLICES_PATH_DEFAULT;
  return resolve(ROOT, override);
}

/** Lê e valida `scripts/mutations/slices.json` (ou `path`, para teste),
 * extraindo só `slice`/`script`. */
export function readSliceConfigs(path: string = resolveSlicesPath()): readonly SliceConfig[] {
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

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}

/** `true` só quando o próprio `spawnSync` matou o processo por ter estourado
 * `timeout` — a causa que o comentário histórico de `evaluateRun` (issue
 * #155) dizia cobrir mas que `realExecute` interceptava antes, lançando sem
 * nomear a fatia (achado 1 do revisor, PR #194). */
function isTimeoutError(error: Error | undefined): boolean {
  return error !== undefined && isErrnoException(error) && error.code === "ETIMEDOUT";
}

/** Reduz uma corrida bruta ao relatório interpretado e ao digest
 * determinístico (sha256 da linha JSON bruta — não uma reserialização, para
 * que reordenar chaves no runner nunca esconda não-determinismo real).
 * Nomeia a causa em vez de deixar `extractJsonLine` relatar "sem relatório"
 * para o sintoma errado: timeout do `spawnSync` vira
 * `MUTATION_ALL_TIMEOUT:<fatia>`; qualquer outro erro do próprio `spawnSync`
 * (ex.: `ENOENT`) propaga como está; sinal sem `error` (morte externa, sem
 * timeout) vira `MUTATION_ALL_KILLED:<fatia>:<sinal>`; e um relatório que
 * sai limpo mas cujo processo termina com `status !== 0` — runner que
 * imprime e morre depois, no `finally` ou por unhandled rejection — vira
 * `MUTATION_ALL_EXIT:<fatia>:<status>` em vez de passar como verde (achado 2
 * do revisor, PR #194). */
export function evaluateRun(
  run: RunResult,
  context: string,
): { readonly report: ParsedSliceReport; readonly digest: string } {
  if (isTimeoutError(run.error)) throw new Error(`MUTATION_ALL_TIMEOUT:${context}`);
  if (run.error !== undefined) throw run.error;
  if (run.signal !== null) throw new Error(`MUTATION_ALL_KILLED:${context}:${run.signal}`);
  const line = extractJsonLine(`${run.stdout}\n${run.stderr}`, context);
  const report = parseSliceReport(line, context);
  if (run.status !== 0) throw new Error(`MUTATION_ALL_EXIT:${context}:${String(run.status)}`);
  return { report, digest: sha256(line) };
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

/** Só `cwd`/`timeoutMs` são para teste (issue #196); `main()` chama
 * `realExecute` sem overrides, sempre `ROOT` e `RUN_TIMEOUT_MS`. */
export interface RealExecuteOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** Roda `npm run <script>` de verdade. Nunca lança — toda interpretação de
 * `status`/`signal`/`error` é de `evaluateRun`. */
export function realExecute(script: string, options: RealExecuteOptions = {}): RunResult {
  const { cwd = ROOT, timeoutMs = RUN_TIMEOUT_MS } = options;
  const result = spawnSync("npm", ["run", script], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
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
