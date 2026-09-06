// Harness comum de mutação (issue #148, passo 0a do épico #13). Fatia a
// família A que os seis runners de `scripts/parity/**` reimplementam cada um
// à sua maneira (t16 `run-mutations.ts:772-826`, t15
// `workflow-executor/run-mutations.ts:590-626`, t17
// `workflow-audit-live/run-mutations.ts:536-570`):
//
//   git status --porcelain limpo -> git rev-parse HEAD -> mkdtemp ->
//   git archive | tar -x -> symlink de node_modules -> aplicar edit
//   exato-uma-vez -> vitest run <focal> -t <título> -> restaurar -> rodar
//   verde de novo.
//
// STUB: ainda não implementado (commit test(red) da issue #148). Nada aqui
// importa de `scripts/parity/**` — essa regra é AC da issue e é verificada
// em teste.
import type { Edit, Focus, MutationReport } from "./types.js";

export interface RunOutcome {
  readonly exitCode: number | null;
  readonly failedTests: readonly string[];
  readonly ranTests: number;
}

/** Substitui `before` por `after` em `source`; lança se a âncora não ocorrer
 * exatamente uma vez. Função pura — não toca disco. */
export function replaceExactlyOnce(
  _source: string,
  _before: string,
  _after: string,
  _id: string,
): string {
  throw new Error("not implemented: replaceExactlyOnce");
}

/** Lê `directory/edit.file`, aplica `replaceExactlyOnce` e escreve de volta. */
export function applyEditExactlyOnce(_directory: string, _edit: Edit, _id: string): void {
  throw new Error("not implemented: applyEditExactlyOnce");
}

/** Snapshot byte a byte (sem decodificar) do conteúdo atual de cada arquivo
 * em `files`, relativo a `directory`. */
export function snapshotFiles(
  _directory: string,
  _files: readonly string[],
): ReadonlyMap<string, Buffer> {
  throw new Error("not implemented: snapshotFiles");
}

/** Restaura cada arquivo do snapshot, byte a byte. */
export function restoreAll(_directory: string, _snapshot: ReadonlyMap<string, Buffer>): void {
  throw new Error("not implemented: restoreAll");
}

/**
 * Prepara um sandbox descartável para `candidateSha`: recusa se
 * `git status --porcelain` em `root` não estiver vazio, cria um `mkdtemp`,
 * extrai `git archive --format=tar candidateSha | tar -x` nele e faz
 * symlink de `root/node_modules` para dentro do sandbox. Devolve o caminho
 * do sandbox; quem chama é responsável por removê-lo depois.
 */
export function prepareArchiveSandbox(_root: string, _candidateSha: string): string {
  throw new Error("not implemented: prepareArchiveSandbox");
}

/** Interpreta a saída de `vitest run --reporter=json` num `RunOutcome`
 * determinístico (sem timestamps/duração). Função pura. */
export function parseVitestOutcome(_stdout: string, _exitCode: number | null): RunOutcome {
  throw new Error("not implemented: parseVitestOutcome");
}

/** Roda `vitest run <focus.file> -t <focus.test>` dentro de `directory`. */
export function runFocusedVitest(_directory: string, _focus: Focus): RunOutcome {
  throw new Error("not implemented: runFocusedVitest");
}

/** Um mutante só é `killed` quando o processo saiu com código diferente de
 * zero E pelo menos um teste falhou nesse foco. */
export function classify(_exitCode: number | null, _failedTests: readonly string[]): boolean {
  throw new Error("not implemented: classify");
}

/** Escreve `report` em `dir/mutations.json`, em JSON canônico (chaves
 * ordenadas, terminado em newline). */
export function writeReport(_dir: string, _report: MutationReport): void {
  throw new Error("not implemented: writeReport");
}
