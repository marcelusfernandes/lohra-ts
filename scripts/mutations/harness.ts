// Harness comum de mutação (issue #148, passo 0a do épico #13). Fatia a
// família A que os runners legados de paridade reimplementavam cada um à
// sua maneira antes da migração (t16, t15, t17):
//
//   git status --porcelain limpo -> git rev-parse HEAD -> mkdtemp ->
//   git archive | tar -x -> symlink de node_modules -> aplicar edit
//   exato-uma-vez -> vitest run <focal> -t <título> -> restaurar -> rodar
//   verde de novo.
//
// Nada aqui importa da árvore legada de paridade — as duas árvores são
// independentes (issue #148); a única coisa realmente compartilhada é
// `canonical.ts`, copiado, não importado.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "./canonical.js";
import type { Edit, Focus, MutationReport } from "./types.js";

/**
 * Guarda de entry-point compartilhada pelos seis runners de
 * `scripts/mutations/`: `if (ehEntryPoint(import.meta.url)) main();`. Molde
 * de `scripts/provenance/check-ancestry.ts` `ehEntryPoint()`, mas parametrizada
 * pela URL do MÓDULO CHAMADOR — um helper aqui em `harness.ts` não pode
 * comparar a própria `import.meta.url` (a de `harness.ts`) contra
 * `process.argv[1]`; só o módulo importador sabe qual é a sua própria URL.
 * Devolve `true` só quando o processo foi invocado com este módulo como
 * script de entrada (`tsx scripts/mutations/<runner>.ts`), nunca quando o
 * módulo foi importado por outro (teste, outro runner) — issue #186.
 */
export function ehEntryPoint(moduleUrl: string): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return moduleUrl === pathToFileURL(resolve(invocado)).href;
}

export interface RunOutcome {
  readonly exitCode: number | null;
  readonly failedTests: readonly string[];
  readonly ranTests: number;
}

/** Substitui `before` por `after` em `source`; lança se a âncora não ocorrer
 * exatamente uma vez. Função pura — não toca disco. */
export function replaceExactlyOnce(
  source: string,
  before: string,
  after: string,
  id: string,
): string {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${id}: mutation anchor not found`);
  if (source.indexOf(before, first + before.length) >= 0)
    throw new Error(`${id}: mutation anchor is not unique`);
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

/** Lê `directory/edit.file`, aplica `replaceExactlyOnce` e escreve de volta. */
export function applyEditExactlyOnce(directory: string, edit: Edit, id: string): void {
  const path = join(directory, edit.file);
  const source = readFileSync(path, "utf8");
  writeFileSync(path, replaceExactlyOnce(source, edit.before, edit.after, id), "utf8");
}

/** Snapshot byte a byte (sem decodificar) do conteúdo atual de cada arquivo
 * em `files`, relativo a `directory`. */
export function snapshotFiles(
  directory: string,
  files: readonly string[],
): ReadonlyMap<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  for (const file of files) snapshot.set(file, readFileSync(join(directory, file)));
  return snapshot;
}

/** Restaura cada arquivo do snapshot, byte a byte. */
export function restoreAll(directory: string, snapshot: ReadonlyMap<string, Buffer>): void {
  for (const [file, original] of snapshot) writeFileSync(join(directory, file), original);
}

/**
 * Prepara um sandbox descartável para `candidateSha`: recusa se
 * `git status --porcelain` em `root` não estiver vazio, cria um `mkdtemp`,
 * extrai `git archive --format=tar candidateSha | tar -x` nele e faz
 * symlink de `root/node_modules` para dentro do sandbox. Devolve o caminho
 * do sandbox; quem chama é responsável por removê-lo depois. Em qualquer
 * falha depois do `mkdtemp`, o sandbox parcial é removido antes de propagar
 * o erro — ninguém herda um diretório órfão de uma corrida que nunca chegou
 * a existir de verdade.
 */
export function prepareArchiveSandbox(root: string, candidateSha: string): string {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (status.status !== 0 || status.stdout !== "")
    throw new Error(
      `mutation run requires a committed candidate with clean porcelain: ${status.stderr}`,
    );

  const sandbox = mkdtempSync(join(tmpdir(), "lohra-mutations-"));
  try {
    const archive = spawnSync("git", ["archive", "--format=tar", candidateSha], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (archive.status !== 0)
      throw new Error(`git archive failed for ${candidateSha}: ${archive.stderr.toString("utf8")}`);
    const extracted = spawnSync("tar", ["-xf", "-", "-C", sandbox], {
      input: archive.stdout,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (extracted.status !== 0)
      throw new Error(`tar extraction failed: ${extracted.stderr.toString("utf8")}`);
    symlinkSync(resolve(root, "node_modules"), join(sandbox, "node_modules"), "dir");
    return sandbox;
  } catch (cause) {
    rmSync(sandbox, { recursive: true, force: true });
    throw cause;
  }
}

interface VitestJsonReport {
  readonly testResults?: readonly {
    readonly assertionResults?: readonly { readonly status: string; readonly fullName: string }[];
  }[];
}

function isVitestJsonReport(value: unknown): value is VitestJsonReport {
  return typeof value === "object" && value !== null;
}

/** Interpreta a saída de `vitest run --reporter=json` num `RunOutcome`
 * determinístico (sem timestamps/duração). Função pura.
 *
 * Sem JSON balanceado no stdout é uma falha do HARNESS, não um teste que
 * rodou e não falhou — devolver um sentinela deixaria `classify` ler
 * `killed: true` para um mutante que nunca chegou a rodar (veredito da PR
 * #170, reason 1). Por isso lança, com o `stderr` do subprocesso na causa. */
export function parseVitestOutcome(
  stdout: string,
  exitCode: number | null,
  stderr = "",
): RunOutcome {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`vitest produced no JSON report (exitCode=${String(exitCode)}): ${stderr}`);
  }
  const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
  const report = isVitestJsonReport(parsed) ? parsed : {};
  const assertions = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  const ran = assertions.filter(
    (assertion) => assertion.status !== "pending" && assertion.status !== "skipped",
  );
  return {
    exitCode,
    failedTests: ran
      .filter((assertion) => assertion.status === "failed")
      .map((assertion) => assertion.fullName)
      .sort(),
    ranTests: ran.length,
  };
}

function runVitestReporterJson(directory: string, args: readonly string[]): RunOutcome {
  const result = spawnSync(
    join(directory, "node_modules/.bin/vitest"),
    ["run", ...args, "--reporter=json", "--outputFile=/dev/stdout"],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  return parseVitestOutcome(result.stdout, result.status, result.stderr);
}

/** Roda `vitest run <focus.file> -t <focus.test>` dentro de `directory`. */
export function runFocusedVitest(directory: string, focus: Focus): RunOutcome {
  return runVitestReporterJson(directory, [focus.file, "-t", focus.test]);
}

/** Lança se `outcome` não é um baseline verde: precisa exitCode 0 E ter
 * rodado pelo menos um teste (o runner original, t16 `run-mutations.ts:845`,
 * já tinha esta guarda; sem ela um foco obsoleto — `-t` que não bate
 * nenhum teste — sai `{exitCode:0, ranTests:0}` e nunca prova nada). */
export function assertBaselineGreen(outcome: RunOutcome, context: string): void {
  if (outcome.exitCode !== 0 || outcome.ranTests === 0)
    throw new Error(
      `${context}: baseline is not green (exit=${String(outcome.exitCode)}, ran=${String(outcome.ranTests)})`,
    );
}

/** O mesmo predicado do baseline, aplicado depois de `restoreAll`: devolve
 * `true` só quando o foco voltou a sair 0 E rodou pelo menos um teste
 * (t16 `run-mutations.ts:882`). Não lança — o chamador guarda o resultado
 * como dado no relatório (`restoreGreen`), não como fault fatal. */
export function assertRestoreGreen(outcome: RunOutcome): boolean {
  return outcome.exitCode === 0 && outcome.ranTests > 0;
}

/** Roda `vitest run <files...>` (sem `-t`) dentro de `directory` — a forma
 * que t15 usa: a mesma bateria de arquivos focais roda inteira para cada
 * mutante, sem afunilar num teste único. */
export function runVitestFiles(directory: string, files: readonly string[]): RunOutcome {
  return runVitestReporterJson(directory, [...files]);
}

/** Um mutante só é `killed` quando o processo saiu com código diferente de
 * zero E pelo menos um teste falhou nesse foco. */
export function classify(exitCode: number | null, failedTests: readonly string[]): boolean {
  return exitCode !== 0 && failedTests.length > 0;
}

/** Escreve `report` em `dir/mutations.json`, em JSON canônico (chaves
 * ordenadas, terminado em newline). */
export function writeReport(dir: string, report: MutationReport): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mutations.json"), canonicalJson(report), "utf8");
}
