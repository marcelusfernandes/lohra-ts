/** Comparador opt-in: compila cada revisão ANTES de rodar a mesma prova final. */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { montarResumo } from "../../prova/resumo.js";
import { normalizarRelatorioVitest } from "../../prova/vitest-relatorio.js";
import {
  prepareWindowsHelper,
  verifyWindowsHelper,
  type PreparedWindowsHelper,
} from "../../subprocess/windows-helper/prepare.js";
import { causaGit, git, gitDiffNameStatus } from "../lib/git.js";
import { classificar, validarResumo } from "./lib.js";
import { linkNodeModules, overlay, rodarProvaNaBase, worktreeAdd } from "./run.js";

const SLUG = /^[a-z0-9-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const SOURCE = /^[A-Za-z0-9_./ -]+\.cs$/;
const MAX_REPORT = 16 * 1024 * 1024;

export interface NativeArgs {
  readonly base: string;
  readonly head: string;
  readonly root: string;
  readonly slug: string;
  readonly compiler: string;
  readonly sources: readonly string[];
  readonly red?: string;
}

export function parseNativeArgs(argv: readonly string[]): NativeArgs {
  const values = new Map<string, string>();
  const sources: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--native") continue;
    const value = argv[++i];
    if (
      flag === undefined ||
      value === undefined ||
      !["--base", "--head", "--root", "--slug", "--compiler", "--source", "--red"].includes(flag) ||
      value.startsWith("--")
    )
      throw new Error("NATIVE_ARGUMENTS");
    if (flag === "--source") sources.push(value);
    else {
      if (values.has(flag)) throw new Error("NATIVE_ARGUMENTS");
      values.set(flag, value);
    }
  }
  const base = values.get("--base");
  const head = values.get("--head");
  const slug = values.get("--slug");
  const compiler = values.get("--compiler");
  if (!base || !head || !slug || !compiler || sources.length === 0 || !SLUG.test(slug)) {
    throw new Error("NATIVE_ARGUMENTS");
  }
  if (
    !isAbsolute(compiler) ||
    !sources.every(validSource) ||
    new Set(sources).size !== sources.length
  ) {
    throw new Error("NATIVE_ARGUMENTS");
  }
  const root = resolve(values.get("--root") ?? process.cwd());
  const red = values.get("--red");
  return {
    base,
    head,
    root,
    slug,
    compiler,
    sources: [...sources].sort(),
    ...(red ? { red } : {}),
  };
}

function validSource(source: string): boolean {
  return (
    SOURCE.test(source) &&
    !source.startsWith("/") &&
    !source.startsWith("prova/") &&
    source.split("/").every((part) => part !== "." && part !== "..")
  );
}

function checkedGit(root: string, args: readonly string[]): string {
  const result = git(root, args);
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error(`NATIVE_GIT: ${causaGit(result)}`);
  }
  return result.stdout.trim();
}

function fullSha(root: string, ref: string): string {
  const sha = checkedGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!SHA.test(sha)) throw new Error("NATIVE_REF_INVALID");
  return sha;
}

function isAncestor(root: string, parent: string, child: string): boolean {
  const result = git(root, ["merge-base", "--is-ancestor", parent, child]);
  if (result.error !== undefined || result.signal !== null || ![0, 1].includes(result.status)) {
    throw new Error(`NATIVE_ANCESTRY: ${causaGit(result)}`);
  }
  return result.status === 0;
}

/** Nenhuma heurística de ordem: zero/múltiplos candidatos exigem decisão explícita. */
export function selectNativeRed(args: NativeArgs): string {
  const base = fullSha(args.root, args.base);
  const head = fullSha(args.root, args.head);
  if (base === head || !isAncestor(args.root, base, head)) throw new Error("NATIVE_ANCESTRY");
  const lines = checkedGit(args.root, ["log", "--format=%H%x01%s", `${base}..${head}`]);
  const candidates = lines
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [sha, subject] = line.split("\x01");
      return sha && subject?.startsWith("test(red):") ? [sha] : [];
    });
  const red = args.red
    ? fullSha(args.root, args.red)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (
    !red ||
    !candidates.includes(red) ||
    !isAncestor(args.root, base, red) ||
    !isAncestor(args.root, red, head)
  ) {
    throw new Error(`NATIVE_RED_SELECTION: ${String(candidates.length)} candidates`);
  }
  const changed = gitDiffNameStatus(args.root, `${red}^`, red).map((entry) => entry.arquivo);
  if (
    !changed.some((path) => args.sources.includes(path) && !path.startsWith("tests/")) ||
    !changed.some((path) => path.startsWith("tests/") || path === `prova/${args.slug}.ts`)
  ) {
    throw new Error("NATIVE_RED_CONTENT: fonte e teste/prova exigidos");
  }
  for (const source of args.sources) {
    for (const sha of source.startsWith("tests/") ? [head] : [red, head]) {
      checkedGit(args.root, ["cat-file", "-e", `${sha}:${source}`]);
    }
  }
  checkedGit(args.root, ["cat-file", "-e", `${head}:prova/${args.slug}.ts`]);
  return red;
}

function overlayFiles(root: string, head: string, redSha: string, redPath: string): void {
  const changes = gitDiffNameStatus(root, redSha, head).filter(
    ({ arquivo }) => arquivo.startsWith("tests/") || arquivo.startsWith("prova/"),
  );
  overlay(redPath, head, changes, (arquivo) => {
    const result = spawnSync("git", ["show", `${head}:${arquivo}`], {
      cwd: root,
      encoding: "buffer",
    });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  });
}

function treeBytes(root: string, prefix: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const dir = join(root, prefix);
  if (!existsSync(dir)) return result;
  function visit(path: string): void {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error("NATIVE_OVERLAY_REPARSE");
      if (info.isDirectory()) visit(full);
      else if (info.isFile())
        result.set(relative(root, full).split(sep).join("/"), readFileSync(full));
      else throw new Error("NATIVE_OVERLAY_TYPE");
    }
  }
  visit(dir);
  return result;
}

function assertSameOverlay(red: string, head: string): void {
  for (const prefix of ["tests", "prova"]) {
    const left = treeBytes(red, prefix);
    const right = treeBytes(head, prefix);
    if (
      left.size !== right.size ||
      [...left].some(([key, bytes]) => !bytes.equals(right.get(key) ?? Buffer.alloc(0)))
    ) {
      throw new Error(`NATIVE_OVERLAY_MISMATCH: ${prefix}`);
    }
  }
}

function declaredUnits(proof: string): readonly string[] {
  const match = /unit:\s*\[([^\]]*)\]/s.exec(readFileSync(proof, "utf8"));
  if (!match) throw new Error("NATIVE_PROOF_DECLARATION");
  const body = match[1];
  if (body === undefined) throw new Error("NATIVE_PROOF_DECLARATION");
  const entries = [...body.matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1] ?? "");
  if (entries.length === 0 || entries.some((entry) => !/^tests\/[\w./-]+\.test\.ts$/.test(entry))) {
    throw new Error("NATIVE_PROOF_DECLARATION");
  }
  return entries;
}

function compileAt(root: string, args: NativeArgs, outputDir: string): PreparedWindowsHelper {
  const sources = args.sources.map((source) => join(root, source));
  const artifact = prepareWindowsHelper({ sources, outputDir, compilerPath: args.compiler });
  verifyWindowsHelper(artifact);
  return artifact;
}

function readFresh(root: string, slug: string, units: readonly string[]) {
  const dir = join(root, ".prova", slug);
  const vitest = join(dir, "vitest.json");
  const summary = join(dir, "resumo.json");
  for (const file of [vitest, summary]) {
    if (!existsSync(file) || lstatSync(file).size > MAX_REPORT)
      throw new Error("NATIVE_REPORT_MISSING_OR_LARGE");
  }
  const normalized = normalizarRelatorioVitest(
    root,
    JSON.parse(readFileSync(vitest, "utf8")) as unknown,
  );
  const recomputed = montarResumo(units, normalized);
  const reported = validarResumo(JSON.parse(readFileSync(summary, "utf8")) as unknown, summary);
  if (JSON.stringify(recomputed) !== JSON.stringify(reported))
    throw new Error("NATIVE_REPORT_MISMATCH");
  return recomputed;
}

function proofAt(
  root: string,
  args: NativeArgs,
  artifact: PreparedWindowsHelper,
  expectedRed: boolean,
): void {
  const units = declaredUnits(join(root, "prova", `${args.slug}.ts`));
  for (const unit of units)
    if (!existsSync(join(root, unit))) throw new Error("NATIVE_PROOF_UNIT_MISSING");
  const reportDir = join(root, ".prova", args.slug);
  rmSync(reportDir, { recursive: true, force: true });
  const result = rodarProvaNaBase(root, args.slug, {
    LOHRA_NATIVE_HELPER_EXE: verifyWindowsHelper(artifact),
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status === null ||
    result.status !== (expectedRed ? 1 : 0)
  ) {
    throw new Error(
      `NATIVE_PROOF_PROCESS: ${result.error?.message ?? String(result.signal ?? result.status)}`,
    );
  }
  const summary = readFresh(root, args.slug, units);
  if (summary.total < 1 || (expectedRed ? classificar(summary) !== "assertion-red" : !summary.ok)) {
    throw new Error(`NATIVE_PROOF_RESULT: ${classificar(summary)} total=${String(summary.total)}`);
  }
}

export function runNative(argv: readonly string[]): number {
  const args = parseNativeArgs(argv);
  if (process.platform !== "win32") throw new Error("NATIVE_PLATFORM_WINDOWS_REQUIRED");
  const redSha = selectNativeRed(args);
  const headSha = fullSha(args.root, args.head);
  const temp = mkdtempSync(join(tmpdir(), "lohra-native-negative-"));
  const red = join(temp, "red");
  const head = join(temp, "head");
  let redAdded = false;
  let headAdded = false;
  let primary: unknown;
  try {
    redAdded = worktreeAdd(args.root, red, redSha);
    if (!redAdded) throw new Error("NATIVE_WORKTREE_RED");
    headAdded = worktreeAdd(args.root, head, headSha);
    if (!headAdded) throw new Error("NATIVE_WORKTREE_HEAD");
    overlayFiles(args.root, headSha, redSha, red);
    assertSameOverlay(red, head);
    linkNodeModules(args.root, red);
    linkNodeModules(args.root, head);
    const redArtifact = compileAt(red, args, join(temp, "red-bin"));
    const headArtifact = compileAt(head, args, join(temp, "head-bin"));
    proofAt(red, args, redArtifact, true);
    proofAt(head, args, headArtifact, false);
  } catch (cause) {
    primary = cause;
  }
  const cleanupErrors: unknown[] = [];
  for (const [path, added] of [
    [head, headAdded],
    [red, redAdded],
  ] as const) {
    if (added) {
      const result = git(args.root, ["worktree", "remove", "--force", path]);
      if (result.error !== undefined || result.status !== 0)
        cleanupErrors.push(new Error(`NATIVE_CLEANUP_WORKTREE: ${causaGit(result)}`));
    }
  }
  try {
    rmSync(temp, { recursive: true, force: true });
  } catch (cause) {
    cleanupErrors.push(cause);
  }
  if (primary !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(primary === undefined ? [] : [primary]), ...cleanupErrors],
      `NATIVE_FAILED: ${String(primary)}; cleanup=${String(cleanupErrors.length)}`,
    );
  }
  process.stdout.write(
    `controle-negativo: nativo assertion-red ${redSha} / verde ${headSha} / ${args.slug} — PASS\n`,
  );
  return 0;
}
