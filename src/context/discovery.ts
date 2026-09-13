import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const VCS_MARKERS = [".git", ".hg", ".claude"] as const;
const BUILD_MARKERS = ["pyproject.toml", "package.json", "go.mod", "Cargo.toml"] as const;
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const PROJECT_SKILL_DIRS = [".claude/skills", ".lohra/skills"] as const;
const MAX_CHARS = 32_000;
const MAX_BYTES = 128_000;
const MAX_WALK = 25;

/** Issue #588 (épico #575, P12): timeout por comando git ao montar o
 * snapshot de ambiente — nenhum comando pode travar a construção do system
 * prompt (invariante 1, CLAUDE.md: construído uma vez por sessão). */
const GIT_TIMEOUT_MS = 500;
const GIT_STATUS_MAX_LINES = 20;
const GIT_RECENT_COMMIT_COUNT = 5;

export type PathResolver = (path: string) => string;

function resolveInput(path: string): string {
  const suffix: string[] = [];
  let current = resolve(path);
  try {
    return realpathSync(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    suffix.unshift(basename(current));
    current = parent;
    try {
      return join(realpathSync(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function ancestors(start: string): string[] {
  const result = [start];
  let current = start;
  while (result.length < MAX_WALK) {
    const parent = dirname(current);
    if (parent === current) break;
    result.push(parent);
    current = parent;
  }
  return result;
}

function hasMarker(directory: string, markers: readonly string[]): boolean {
  return markers.some((marker) => existsSync(join(directory, marker)));
}

export function findProjectRoot(start: string, resolver: PathResolver = resolveInput): string {
  const resolved = resolver(start);
  const candidates = ancestors(resolved);
  return (
    candidates.find((directory) => hasMarker(directory, VCS_MARKERS)) ??
    candidates.find((directory) => hasMarker(directory, BUILD_MARKERS)) ??
    resolved
  );
}

function isWithin(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export function readTextBounded(path: string, maxBytes: number): string | undefined {
  let descriptor: number | undefined;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    const count = readSync(descriptor, buffer, 0, maxBytes + 1, 0);
    return buffer.subarray(0, Math.min(count, maxBytes)).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readInstruction(path: string): string | undefined {
  const text = readTextBounded(path, MAX_BYTES);
  if (text === undefined) return undefined;
  const points = Array.from(text);
  return points.length > MAX_CHARS
    ? `${points.slice(0, MAX_CHARS).join("")}\n\n[...truncated]`
    : text;
}

export type ContextFile = readonly [label: string, content: string];

/** Issue #582 (épico #575, P6): `AGENTS.md` e `CLAUDE.md` no mesmo
 * diretório costumam ter texto byte-idêntico (o épico mede 96% de um
 * prompt deste próprio repositório vindo dos dois juntos) — entram como um
 * `<context-file>` só, com o label composto (`"AGENTS.md = CLAUDE.md"`,
 * ordem de descoberta preservada), em vez de repetir o mesmo conteúdo duas
 * vezes no prompt. Conteúdo diferente nunca é agrupado, mesmo vindo do
 * mesmo diretório. Nova lista, `found` nunca é mutada. */
function dedupeIdenticalContent(files: readonly ContextFile[]): ContextFile[] {
  const contentOrder: string[] = [];
  const labelsByContent = new Map<string, string[]>();
  for (const [label, content] of files) {
    const labels = labelsByContent.get(content);
    if (labels === undefined) {
      labelsByContent.set(content, [label]);
      contentOrder.push(content);
    } else {
      labels.push(label);
    }
  }
  return contentOrder.map((content) => [(labelsByContent.get(content) ?? []).join(" = "), content]);
}

export function discoverInstructions(
  cwd: string,
  suppliedRoot?: string,
  resolver: PathResolver = resolveInput,
): ContextFile[] {
  const start = resolver(cwd);
  const root = resolver(suppliedRoot ?? findProjectRoot(start, resolver));
  if (!isWithin(start, root)) throw new Error("PROJECT_ROOT_NOT_ANCESTOR");
  const found: ContextFile[] = [];
  const seen = new Set<string>();
  for (const directory of ancestors(start)) {
    for (const name of INSTRUCTION_FILES) {
      if (seen.has(name)) continue;
      const content = readInstruction(join(directory, name));
      if (content !== undefined) {
        const label = relative(root, join(directory, name)) || name;
        found.push([label, content]);
        seen.add(name);
      }
    }
    if (directory === root) break;
  }
  return dedupeIdenticalContent(found);
}

export interface ProjectContext {
  readonly instructions: readonly ContextFile[];
  readonly hints: Readonly<Record<string, string>>;
}

/** Issue #588 (épico #575, P12): plataforma, shell e versão de node —
 * nunca dependem de `cwd` nem de git, sempre presentes. `shell` espelha o
 * fallback que `terminal.ts`'s `shellInvocation` já usa para decidir qual
 * shell de fato roda um comando (`process.env.ComSpec`/`SHELL`), para o
 * hint nunca prometer um shell diferente do que a tool `terminal` usaria. */
function staticEnvironmentHints(): Readonly<Record<string, string>> {
  const shell =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/sh");
  return { platform: process.platform, node: process.version, shell };
}

/** Roda um comando git local, fail-open: qualquer erro (não é repositório,
 * `git` ausente, exit não-zero, timeout) devolve `undefined`, nunca lança.
 * `gitBinary` é injetável só para teste (um executável falso que trava ou
 * sai não-zero, sem depender de mutar `PATH`). Nunca acessa rede — só
 * subcomandos que leem o estado local (`status`, `log`, `symbolic-ref`,
 * `rev-parse`). */
function tryGit(gitBinary: string, args: readonly string[], cwd: string): string | undefined {
  try {
    return execFileSync(gitBinary, args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function formatGitStatus(status: string): string {
  if (status.length === 0) return "clean";
  const lines = status.split("\n").filter((line) => line.length > 0);
  if (lines.length <= GIT_STATUS_MAX_LINES) return lines.join("\n");
  const shown = lines.slice(0, GIT_STATUS_MAX_LINES);
  const hidden = lines.length - GIT_STATUS_MAX_LINES;
  return `${shown.join("\n")}\n... (${String(hidden)} more, truncated)`;
}

/** `refs/remotes/origin/HEAD` só existe quando alguém já rodou
 * `git remote set-head` (ou clonou com espelhamento) — nunca é resolvido
 * por rede aqui; ausência é o caso comum e fail-open (chave omitida). */
function gitDefaultBranch(gitBinary: string, cwd: string): string | undefined {
  const ref = tryGit(gitBinary, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (ref === undefined || ref.length === 0) return undefined;
  const slash = ref.indexOf("/");
  const short = slash === -1 ? ref : ref.slice(slash + 1);
  return short.length === 0 ? undefined : short;
}

/** Issue #588: snapshot de git — branch, branch default, status curto e
 * commits recentes. Um único comando de porteiro (`rev-parse
 * --show-toplevel`) decide se `cwd` está dentro de um repositório antes de
 * tentar o resto: fora de um repositório (o caso comum), isso custa uma
 * falha rápida em vez de quatro; um `git` falso que trava também só paga o
 * timeout uma vez. Cada chave depois do porteiro ainda falha
 * independentemente (fail-open por comando, nunca em bloco). */
function gitSnapshot(cwd: string, gitBinary: string): Readonly<Record<string, string>> {
  const hints: Record<string, string> = {};
  if (tryGit(gitBinary, ["rev-parse", "--show-toplevel"], cwd) === undefined) return hints;

  const branch =
    tryGit(gitBinary, ["symbolic-ref", "--short", "HEAD"], cwd) ??
    tryGit(gitBinary, ["rev-parse", "--short", "HEAD"], cwd);
  if (branch !== undefined && branch.length > 0) hints.git_branch = branch;

  const defaultBranch = gitDefaultBranch(gitBinary, cwd);
  if (defaultBranch !== undefined) hints.git_default_branch = defaultBranch;

  const status = tryGit(gitBinary, ["status", "--porcelain"], cwd);
  if (status !== undefined) hints.git_status = formatGitStatus(status);

  const recent = tryGit(
    gitBinary,
    ["log", `-${String(GIT_RECENT_COMMIT_COUNT)}`, "--oneline"],
    cwd,
  );
  if (recent !== undefined && recent.length > 0) hints.git_recent = recent;

  return hints;
}

export function loadProjectContext(
  cwd: string,
  resolver: PathResolver = resolveInput,
  gitBinary = "git",
): ProjectContext {
  const environment = staticEnvironmentHints();
  try {
    const root = findProjectRoot(cwd, resolver);
    const resolved = resolver(cwd);
    return {
      instructions: discoverInstructions(resolved, root, resolver),
      hints: {
        cwd: resolved,
        project_root: resolver(root),
        ...environment,
        ...gitSnapshot(resolved, gitBinary),
      },
    };
  } catch {
    return { instructions: [], hints: { cwd, ...environment } };
  }
}

export function discoverSkillRoots(cwd: string): string[] {
  try {
    const root = findProjectRoot(cwd);
    return PROJECT_SKILL_DIRS.map((entry) => join(root, entry)).filter((entry) => {
      try {
        return lstatSync(entry).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
