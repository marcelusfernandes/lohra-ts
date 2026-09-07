// `mutations.yml` (issue #156, épico #13): dado o diff `base...head` de uma
// PR e `scripts/mutations/slices.json`, escolhe as fatias de mutação que a
// PR precisa rodar e emite a matriz para o job `mutate`.
//
// Regras (fail-closed):
//   - todo `srcGlobs` tem a forma `src/<dir>/**` (a mesma que
//     tests/mutations-slices.test.ts prende); qualquer outra forma lança.
//   - arquivo sob `src/<dir>/` seleciona toda fatia cujo `srcGlobs` cita
//     esse `<dir>`; arquivo de topo em `src/` não casa nenhuma.
//   - mudança em `scripts/mutations/**` (harness ou catálogo) seleciona
//     TODAS as fatias — o custo de rodar tudo é menor que o de um harness
//     quebrado passar despercebido.
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
}

export interface MatrixEntry {
  readonly slice: string;
  readonly script: string;
}

export interface Matrix {
  readonly count: number;
  readonly include: readonly MatrixEntry[];
  /** `harness` quando `scripts/mutations/**` mudou; senão `paths`. */
  readonly reason: "harness" | "paths";
}

const HARNESS_PREFIX = "scripts/mutations/";
const GLOB_FORM = /^src\/([^/]+)\/\*\*$/;
const DEFAULT_SLICES = "scripts/mutations/slices.json";

/** `src/<dir>/**` → `<dir>`; qualquer outra forma lança. */
export function globDir(glob: string): string {
  const match = GLOB_FORM.exec(glob);
  const dir = match?.[1];
  if (dir === undefined) {
    throw new Error(`srcGlobs: formato inesperado (esperava "src/<dir>/**"): ${glob}`);
  }
  return dir;
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
  return { slice: value["slice"], script: value["script"], srcGlobs: value["srcGlobs"] };
}

/** Lê e valida `slices.json`; lança em JSON inválido ou forma inesperada. */
export function readSlices(path: string): readonly SliceEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed))
    throw new Error(`${path}: esperava um array (slices.json malformado)`);
  return parsed.map((entry, index) => asSliceEntry(entry, path, index));
}

function touchesDir(files: readonly string[], dir: string): boolean {
  const prefix = `src/${dir}/`;
  return files.some((file) => file.startsWith(prefix));
}

/** Seleciona as fatias que o diff exige. Puro: não lê disco nem `git`. */
export function selectSlices(
  slices: readonly SliceEntry[],
  changedFiles: readonly string[],
): Matrix {
  const dirsBySlice = slices.map((entry) => ({
    entry,
    dirs: entry.srcGlobs.map((glob) => globDir(glob)),
  }));
  const harnessChanged = changedFiles.some((file) => file.startsWith(HARNESS_PREFIX));
  const selected = dirsBySlice
    .filter(({ dirs }) => harnessChanged || dirs.some((dir) => touchesDir(changedFiles, dir)))
    .map(({ entry }) => ({ slice: entry.slice, script: entry.script }));
  return {
    count: selected.length,
    include: selected,
    reason: harnessChanged ? "harness" : "paths",
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
