import { homedir } from "node:os";
import { join } from "node:path";

export interface LohraPaths {
  readonly base: string;
  readonly home: string;
  readonly envFile: string;
  readonly profile: string | null;
}

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validateProfileName(name: string): string {
  if (name.length < 1 || name.length > 64 || !profilePattern.test(name)) {
    throw new Error(
      `invalid profile name '${name}': use letters, digits, '-' or '_' ` +
        "(1-64 chars, no spaces or path separators)",
    );
  }
  return name;
}

function expandUser(path: string, userHome: string): string {
  return path === "~" ? userHome : path.startsWith("~/") ? join(userHome, path.slice(2)) : path;
}

export function resolvePaths(
  environment: Readonly<Record<string, string | undefined>>,
): LohraPaths {
  const userHome = environment.HOME || homedir();
  const base = environment.LOHRA_HOME
    ? expandUser(environment.LOHRA_HOME, userHome)
    : process.platform === "win32"
      ? join(environment.LOCALAPPDATA || userHome, "lohra")
      : join(userHome, ".lohra");
  // `rawProfile === undefined` é a única forma de "profile ausente" — uma
  // string vazia (`LOHRA_PROFILE=""` exportada no shell, ou `--profile ""`
  // via `src/cli.ts`) é uma configuração INVÁLIDA, não a ausência de uma:
  // cai em `validateProfileName`, que já rejeita `length < 1` (issue #653
  // item 2). Sem isso, `""` era falsy e caía silenciosamente no profile
  // default do operador — contra o invariante "falha nunca é silenciosa".
  const rawProfile = environment.LOHRA_PROFILE;
  const profile = rawProfile === undefined ? null : validateProfileName(rawProfile);
  const home = profile === null ? base : join(base, "profiles", profile);
  return { base, home, envFile: join(base, ".env"), profile };
}
