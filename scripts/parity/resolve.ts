import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import process from "node:process";

import { HarnessError } from "./errors.js";
import { runTypeScriptProcess } from "./process.js";

export interface OracleWorkspace {
  readonly root: string;
  readonly repository: string;
  readonly executable: string;
  readonly python: string;
}

interface ResolveOptions {
  readonly cwd: string;
  readonly explicitWorkspace?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

function systemGit(): string {
  const configured = process.env.LOHRA_PARITY_GIT;
  const candidates =
    configured === undefined ? ["/usr/bin/git", "/opt/homebrew/bin/git"] : [configured];
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new HarnessError(
    "GIT_NOT_FOUND",
    "No absolute git executable was found for guard discovery",
  );
}

function ancestors(path: string): readonly string[] {
  const result: string[] = [];
  let current = resolve(path);
  const root = parse(current).root;
  while (current !== root) {
    result.push(current);
    current = dirname(current);
  }
  result.push(root);
  return result;
}

function worktreeCandidates(options: ResolveOptions): readonly string[] {
  const result = runTypeScriptProcess({
    executable: systemGit(),
    argv: ["-C", options.cwd, "worktree", "list", "--porcelain"],
    cwd: options.cwd,
    environment: { PATH: "/usr/bin:/bin" },
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return Buffer.from(result.stdout, "base64")
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function validateWorkspace(path: string): OracleWorkspace | undefined {
  if (!isAbsolute(path) || !existsSync(path)) {
    return undefined;
  }
  const root = realpathSync(path);
  const repository = join(root, "lohra");
  const bin = join(root, ".oracle-venv", "bin");
  const executable = join(bin, "lohra");
  const python = join(bin, "python");
  if (!existsSync(join(repository, ".git")) || !existsSync(executable) || !existsSync(python)) {
    return undefined;
  }
  const realBin = `${realpathSync(bin)}${sep}`;
  const realExecutable = realpathSync(executable);
  if (!realExecutable.startsWith(realBin)) {
    throw new HarnessError(
      "ORACLE_OUTSIDE_VENV",
      "Oracle executable must resolve under the sanctioned .oracle-venv/bin",
    );
  }
  return { root, repository: realpathSync(repository), executable: realExecutable, python };
}

export function resolveOracleWorkspace(options: ResolveOptions): OracleWorkspace {
  const environment = options.environment ?? process.env;
  const selected = options.explicitWorkspace ?? environment.LOHRA_ORACLE_WORKSPACE;
  if (selected !== undefined) {
    if (!isAbsolute(selected)) {
      throw new HarnessError(
        "ORACLE_WORKSPACE_RELATIVE",
        "Oracle workspace binding must be absolute",
      );
    }
    const workspace = validateWorkspace(selected);
    if (workspace === undefined) {
      throw new HarnessError(
        "ORACLE_WORKSPACE_INVALID",
        "Oracle workspace must contain sibling lohra/ and .oracle-venv/bin/lohra",
      );
    }
    return workspace;
  }
  const candidates = [
    ...ancestors(options.cwd),
    ...worktreeCandidates(options).flatMap((path) => ancestors(path)),
  ];
  for (const candidate of [...new Set(candidates)]) {
    const workspace = validateWorkspace(candidate);
    if (workspace !== undefined) {
      return workspace;
    }
  }
  throw new HarnessError(
    "ORACLE_WORKSPACE_NOT_FOUND",
    "Could not discover a sanctioned workspace with lohra/ and .oracle-venv/ siblings",
  );
}

export function resolveExecutable(
  name: string,
  options: {
    readonly oracle?: OracleWorkspace;
    readonly bindings?: Readonly<Record<string, string>>;
  },
): string {
  if (name === "oracle-lohra") {
    if (options.oracle === undefined) {
      throw new HarnessError("EXECUTABLE_BINDING", "oracle-lohra requires an oracle workspace");
    }
    return options.oracle.executable;
  }
  if (name === "node") {
    return process.execPath;
  }
  const binding = options.bindings?.[name];
  if (binding === undefined) {
    throw new HarnessError("EXECUTABLE_BINDING", `Logical executable ${name} is not bound`);
  }
  if (!isAbsolute(binding) || !existsSync(binding)) {
    throw new HarnessError(
      "EXECUTABLE_BINDING",
      `Logical executable ${name} must bind to an existing absolute path`,
    );
  }
  return realpathSync(binding);
}

export function expandArgument(value: string, projectRoot: string): string {
  return value.replaceAll("{{projectRoot}}", projectRoot);
}
