import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const VCS_MARKERS = [".git", ".hg", ".claude"] as const;
const BUILD_MARKERS = ["pyproject.toml", "package.json", "go.mod", "Cargo.toml"] as const;
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const PROJECT_SKILL_DIRS = [".claude/skills", ".lohra/skills"] as const;
const MAX_CHARS = 32_000;
const MAX_BYTES = 128_000;
const MAX_WALK = 25;

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
  return found;
}

export interface ProjectContext {
  readonly instructions: readonly ContextFile[];
  readonly hints: Readonly<Record<string, string>>;
}

export function loadProjectContext(
  cwd: string,
  resolver: PathResolver = resolveInput,
): ProjectContext {
  try {
    const root = findProjectRoot(cwd, resolver);
    const resolved = resolver(cwd);
    return {
      instructions: discoverInstructions(resolved, root, resolver),
      hints: { cwd: resolved, project_root: resolver(root) },
    };
  } catch {
    return { instructions: [], hints: { cwd } };
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
