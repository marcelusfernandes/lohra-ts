import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

export class ProcessShellLaunchError extends Error {
  override readonly name = "ProcessShellLaunchError";

  constructor(
    message: string,
    cause: Error,
    readonly status: number | null = null,
    readonly stderr: string | null = null,
  ) {
    super(message, { cause });
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new ProcessShellLaunchError(`falha ao inspecionar shell: ${cause.message}`, cause);
  }
}

function pathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const key = Object.keys(env)
    .filter((name) => (platform === "win32" ? name.toLowerCase() === "path" : name === "PATH"))
    .at(-1);
  return key === undefined ? "" : (env[key] ?? "");
}

/** Identifica um shell existente sem depender de um drive ou diretório fixo. */
export function resolveProcessShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const windows = platform === "win32";
  const separator = windows ? ";" : ":";
  const directories = pathValue(env, platform)
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter(Boolean);
  const shell = windows ? "sh.exe" : "sh";

  for (const directory of directories) {
    const direct = path.resolve(directory, shell);
    if (isFile(direct)) return direct;
  }
  if (windows) {
    for (const directory of directories) {
      if (!isFile(path.resolve(directory, "git.exe"))) continue;
      for (const ancestor of [path.resolve(directory, ".."), path.resolve(directory, "..", "..")]) {
        for (const candidateDir of ["bin", path.join("usr", "bin")]) {
          const candidate = path.join(ancestor, candidateDir, shell);
          if (isFile(candidate)) return candidate;
        }
      }
    }
  }

  const cause = Object.assign(new Error("sh não encontrado nos diretórios do PATH"), {
    code: "ENOENT",
  });
  throw new ProcessShellLaunchError("shell de processo indisponível (ENOENT)", cause);
}

function childEnvironment(env: NodeJS.ProcessEnv, shellPath: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  // Em Windows, um objeto plano pode trazer `Path` herdado e `PATH` sobrescrito.
  // A última chave deve vencer, como no spread usado pela bancada.
  const pathKey =
    Object.keys(env)
      .filter((key) =>
        process.platform === "win32" ? key.toLowerCase() === "path" : key === "PATH",
      )
      .at(-1) ?? "PATH";
  for (const [key, value] of Object.entries(env)) {
    if (process.platform === "win32" && key.toLowerCase() === "path" && key !== pathKey) continue;
    child[key] = value;
  }
  child[pathKey] = [child[pathKey] ?? "", path.dirname(shellPath)]
    .filter(Boolean)
    .join(path.delimiter);
  return child;
}

/** Lança o shell da bancada preservando argv, stdin, cwd, ambiente e diagnóstico. */
export function spawnProcessShell(
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
  shellPath = resolveProcessShell(options.env ?? process.env),
): SpawnSyncReturns<string> {
  const result = spawnSync(shellPath, args, {
    ...options,
    shell: false,
    env: childEnvironment(options.env ?? process.env, shellPath),
  });
  if (result.error) {
    throw new ProcessShellLaunchError(
      `falha ao lançar shell de processo: ${result.error.message}`,
      result.error,
      result.status,
      result.stderr,
    );
  }
  return result;
}
