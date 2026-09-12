// `mutations.yml` (issue #156, épico #13): dado o diff `base...head` de uma
// PR e `scripts/mutations/slices.json`, escolhe as fatias de mutação que a
// PR precisa rodar e emite a matriz para o job `mutate`.
//
// Regras (fail-closed):
//   - todo `srcGlobs` tem a forma `src/<dir>/**` OU a forma literal
//     `src/<arquivo>.ts` (arquivo de topo -- issue #195: sem ela, um
//     catálogo que edita um arquivo de topo como `src/cli.ts` não tem como
//     disparar a fatia certa); qualquer outra forma lança. Mesmas duas
//     formas que `tests/mutations-slices.test.ts` prende.
//   - arquivo sob `src/<dir>/` seleciona toda fatia cujo `srcGlobs` cita
//     esse `<dir>`; arquivo de topo em `src/` só casa a fatia cujo
//     `srcGlobs` cita esse arquivo exato pela forma literal.
//   - mudança em `scripts/mutations/**` (harness ou catálogo) seleciona
//     TODAS as fatias — o custo de rodar tudo é menor que o de um harness
//     quebrado passar despercebido.
//   - arquivo do diff que aparece em `focusFiles` de uma fatia (issue #514)
//     também seleciona essa fatia, mesmo sem casar `srcGlobs` — é o teste
//     que mata os mutantes dessa fatia; um `it` afrouxado nele não tem por
//     que passar batido pelo required check só porque o arquivo vive sob
//     `tests/`. Quando a fatia é selecionada só por `focusFiles` (nenhum
//     `srcGlobs` dessa fatia casou e não é o caso de harness), `reason` é
//     `"focus"` em vez de `"paths"`.
//
// Dois modos, como `scripts/ci/escopo/run.ts`: CI (`--base`/`--head`, faz o
// diff com `git`) e dry-run (`--files-file`, sem `git`). Saída: JSON em
// stdout e, quando `GITHUB_OUTPUT` está definido, `matrix=` e `count=`.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface SliceEntry {
  readonly slice: string;
  readonly script: string;
  readonly srcGlobs: readonly string[];
  /** Arquivos de `tests/**` cuja edição sozinha já seleciona a fatia (issue
   * #514). Opcional: `slices.json` traz `focusFiles` em toda entrada real,
   * mas fixtures de teste que só exercitam `srcGlobs` podem omitir. */
  readonly focusFiles?: readonly string[];
}

export interface MatrixEntry {
  readonly slice: string;
  readonly script: string;
}

export interface Matrix {
  readonly count: number;
  readonly include: readonly MatrixEntry[];
  /** `harness` quando `scripts/mutations/**` mudou; `focus` quando a seleção
   * depende de algum `focusFiles` (nenhum `srcGlobs` casou); senão `paths`. */
  readonly reason: "harness" | "paths" | "focus";
}

const HARNESS_PREFIX = "scripts/mutations/";
const DIR_GLOB_FORM = /^src\/([^/]+)\/\*\*$/;
const FILE_GLOB_FORM = /^src\/[^/]+\.ts$/;
const DEFAULT_SLICES = "scripts/mutations/slices.json";

/** Um `srcGlobs` já resolvido: prefixo de diretório (`src/<dir>/**`) ou
 * arquivo de topo literal (`src/<arquivo>.ts`, issue #195). */
export type SrcTarget =
  { readonly kind: "dir"; readonly dir: string } | { readonly kind: "file"; readonly file: string };

/** `src/<dir>/**` → `{ kind: "dir", dir }`; `src/<arquivo>.ts` (arquivo de
 * topo) → `{ kind: "file", file: glob }`; qualquer outra forma lança. */
export function globDir(glob: string): SrcTarget {
  const dir = DIR_GLOB_FORM.exec(glob)?.[1];
  if (dir !== undefined) return { kind: "dir", dir };
  if (FILE_GLOB_FORM.test(glob)) return { kind: "file", file: glob };
  throw new Error(
    `srcGlobs: formato inesperado (esperava "src/<dir>/**" ou "src/<arquivo>.ts"): ${glob}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function asSliceEntry(value: unknown, path: string, index: number): SliceEntry {
  if (
    !isRecord(value) ||
    typeof value["slice"] !== "string" ||
    typeof value["script"] !== "string" ||
    !isStringArray(value["srcGlobs"])
  ) {
    throw new Error(
      `${path}: entrada ${String(index)} sem a forma {slice, script, srcGlobs[]} (slices.json malformado)`,
    );
  }
  const focusFilesRaw = value["focusFiles"];
  if (focusFilesRaw !== undefined && !isStringArray(focusFilesRaw)) {
    throw new Error(
      `${path}: entrada ${String(index)} tem focusFiles fora da forma string[] (slices.json malformado)`,
    );
  }
  return {
    slice: value["slice"],
    script: value["script"],
    srcGlobs: value["srcGlobs"],
    ...(focusFilesRaw !== undefined ? { focusFiles: focusFilesRaw } : {}),
  };
}

/** Lê e valida `slices.json`; lança em JSON inválido ou forma inesperada. */
export function readSlices(path: string): readonly SliceEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed))
    throw new Error(`${path}: esperava um array (slices.json malformado)`);
  return parsed.map((entry, index) => asSliceEntry(entry, path, index));
}

function touchesDir(files: readonly string[], target: SrcTarget): boolean {
  if (target.kind === "file") return files.includes(target.file);
  const prefix = `src/${target.dir}/`;
  return files.some((file) => file.startsWith(prefix));
}

/** `true` quando algum arquivo do diff é um `focusFiles` da fatia (issue
 * #514) — comparação exata de caminho, sem prefixo nem glob. */
function touchesFocus(files: readonly string[], focusFiles: readonly string[]): boolean {
  return files.some((file) => focusFiles.includes(file));
}

/** Seleciona as fatias que o diff exige. Puro: não lê disco nem `git`. */
export function selectSlices(
  slices: readonly SliceEntry[],
  changedFiles: readonly string[],
): Matrix {
  const targetsBySlice = slices.map((entry) => ({
    entry,
    targets: entry.srcGlobs.map((glob) => globDir(glob)),
    focusFiles: entry.focusFiles ?? [],
  }));
  const harnessChanged = changedFiles.some((file) => file.startsWith(HARNESS_PREFIX));
  const matched = targetsBySlice.map(({ entry, targets, focusFiles }) => ({
    entry,
    matchedByPath: targets.some((target) => touchesDir(changedFiles, target)),
    matchedByFocus: touchesFocus(changedFiles, focusFiles),
  }));
  const selected = matched.filter(
    ({ matchedByPath, matchedByFocus }) => harnessChanged || matchedByPath || matchedByFocus,
  );
  // "focus" só quando a seleção depende de algum focusFiles (nenhum arquivo
  // dessa fatia bateu srcGlobs) e não é o caso de harness, que já tem seu
  // próprio motivo.
  const dependeDeFocus =
    !harnessChanged &&
    selected.some(({ matchedByPath, matchedByFocus }) => matchedByFocus && !matchedByPath);
  return {
    count: selected.length,
    include: selected.map(({ entry }) => ({ slice: entry.slice, script: entry.script })),
    reason: harnessChanged ? "harness" : dependeDeFocus ? "focus" : "paths",
  };
}

/** `git diff --name-only base...head` no cwd; lança se o git falhar. */
export function changedFiles(base: string, head: string, cwd: string): readonly string[] {
  const diff = spawnSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd,
    encoding: "utf8",
  });
  if (diff.status !== 0) {
    throw new Error(`git diff ${base}...${head} falhou: ${diff.stderr}`);
  }
  return diff.stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

interface Args {
  readonly base?: string;
  readonly head?: string;
  readonly filesFile?: string;
  readonly slices: string;
}

const USO =
  "uso: mutations-matrix.ts (--base <sha> --head <sha> | --files-file <path>) [--slices <path>]";

function parseArgs(argv: readonly string[]): Args {
  const valores = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const valor = argv[i + 1];
    if (flag === undefined || !flag.startsWith("--") || valor === undefined) {
      throw new Error(`argumento inválido em "${flag ?? ""}"\n${USO}`);
    }
    valores.set(flag.slice(2), valor);
  }
  const args: Args = { slices: valores.get("slices") ?? DEFAULT_SLICES };
  const base = valores.get("base");
  const head = valores.get("head");
  const filesFile = valores.get("files-file");
  if (filesFile !== undefined) return { ...args, filesFile };
  if (base !== undefined && head !== undefined) return { ...args, base, head };
  throw new Error(`faltam --base/--head ou --files-file\n${USO}`);
}

function filesFrom(args: Args, cwd: string): readonly string[] {
  if (args.filesFile !== undefined) {
    return readFileSync(args.filesFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
  }
  if (args.base === undefined || args.head === undefined) throw new Error(USO);
  return changedFiles(args.base, args.head, cwd);
}

function emitGithubOutput(matrix: Matrix): void {
  const output = process.env["GITHUB_OUTPUT"];
  if (output === undefined || output.length === 0) return;
  appendFileSync(
    output,
    `matrix=${JSON.stringify(matrix.include)}\ncount=${String(matrix.count)}\n`,
  );
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const cwd = process.cwd();
  const matrix = selectSlices(readSlices(resolve(cwd, args.slices)), filesFrom(args, cwd));
  process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
  emitGithubOutput(matrix);
}

// Guarda de entry-point (idioma de scripts/provenance/check-ancestry.ts): o
// teste importa as funções puras sem disparar `git`/`process.exit`.
function ehEntryPoint(): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invocado)).href;
}

if (ehEntryPoint()) {
  main();
}
