// Issue #533 (D4 do épico #529): numa instalação sem `.git`, `lohra update`
// não tem repositório para consultar — este módulo fala com o registry do
// npm em vez do git. Fetch e execução são sempre injetados pelo chamador
// (nunca `globalThis.fetch`/`spawnSync` direto aqui) para que os testes
// rodem sem rede e sem depender de um `npm` de verdade instalado.
//
// Fail-closed: qualquer falha de rede, resposta inesperada, ou versão que
// não parseia como `x.y.z` vira um `Error` com a causa nomeada, nunca um
// `undefined` silencioso — quem chama decide a mensagem e o exit code.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Assinatura mínima que o Fetch API real satisfaz — só o que este módulo
 * usa, para que os testes injetem um stub sem `Response`/`Headers` reais. */
export interface RegistryFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type RegistryFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<RegistryFetchResponse>;

/** Molde de `CommandRunner` (`src/self-update/repo.ts`) — executable e argv
 * separados, nunca uma string de shell montada aqui. */
export type InstallRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
) => { readonly code: number; readonly stdout: string; readonly stderr: string };

export const REGISTRY_URL = "https://registry.npmjs.org/lohra-ts/latest";
export const REGISTRY_TIMEOUT_MS = 5_000;

export type VersionComparison = "older" | "equal" | "newer";

export interface RegistryUpdateOptions {
  readonly check: boolean;
  readonly yes: boolean;
  readonly currentVersion: string;
  readonly fetchImpl: RegistryFetch;
  readonly runner: InstallRunner;
  readonly cwd: string;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly timeoutMs?: number;
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Consulta `registry.npmjs.org/lohra-ts/latest` com timeout curto e sem
 * retry. Qualquer desvio do caminho feliz (rede fora, status não-ok, corpo
 * sem `version` string) lança com a causa nomeada. */
export async function fetchLatestVersion(
  fetchImpl: RegistryFetch,
  timeoutMs: number = REGISTRY_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    let response: RegistryFetchResponse;
    try {
      response = await fetchImpl(REGISTRY_URL, { signal: controller.signal });
    } catch (error) {
      throw new Error(`could not reach the npm registry: ${causeMessage(error)}`, { cause: error });
    }
    if (!response.ok) {
      throw new Error(`npm registry responded with status ${String(response.status)}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(`npm registry response was not valid JSON: ${causeMessage(error)}`, {
        cause: error,
      });
    }
    const version =
      body !== null && typeof body === "object" && "version" in body ? body.version : undefined;
    if (typeof version !== "string" || version.trim() === "") {
      throw new Error('npm registry response had no string "version" field');
    }
    return version;
  } finally {
    clearTimeout(timer);
  }
}

function parseVersionTriple(value: string): readonly [number, number, number] {
  const parts = value.trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`not a plain x.y.z version: "${value}"`);
  }
  const [major, minor, patch] = parts.map(Number);
  return [major as number, minor as number, patch as number];
}

/** Compara duas versões `x.y.z` (só três partes numéricas — sem pré-release,
 * sem build metadata). Versão que não casa esse formato é fail-closed: lança
 * em vez de adivinhar uma ordem. */
export function compareVersions(current: string, latest: string): VersionComparison {
  const a = parseVersionTriple(current);
  const b = parseVersionTriple(latest);
  for (let index = 0; index < 3; index += 1) {
    const currentPart = a[index] as number;
    const latestPart = b[index] as number;
    if (latestPart > currentPart) return "newer";
    if (latestPart < currentPart) return "older";
  }
  return "equal";
}

/** `npm install -g lohra-ts@<version>` como executable + argv — nunca uma
 * string de shell. */
export function npmInstallArgs(version: string): readonly string[] {
  return ["install", "-g", `lohra-ts@${version}`];
}

/** Versão do próprio pacote instalado, lida do `package.json` que acompanha
 * o módulo em disco (não de uma constante) — dois níveis acima de
 * `src/commands/` ou `dist/commands/`, que é a raiz do pacote nos dois
 * casos. */
export function readInstalledVersion(moduleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(moduleUrl));
  const packageJsonPath = resolve(here, "..", "..", "package.json");
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, "utf8");
  } catch (error) {
    throw new Error(
      `could not read the installed package.json at ${packageJsonPath}: ${causeMessage(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `installed package.json at ${packageJsonPath} is not valid JSON: ${causeMessage(error)}`,
      { cause: error },
    );
  }
  const version =
    parsed !== null && typeof parsed === "object" && "version" in parsed
      ? parsed.version
      : undefined;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`installed package.json at ${packageJsonPath} has no string "version" field`);
  }
  return version;
}

/** Orquestra o contrato inteiro de `lohra update` fora de um checkout git:
 * consulta o registry, compara com a versão instalada, e — só com
 * `options.yes` — executa `npm install -g lohra-ts@<latest>` por
 * executable/argv (sem shell). Sem `options.yes`, imprime o comando exato
 * em stdout e sai 0. Retorna o exit code (0 ou 1 — nunca 2, que é o código
 * de `writeResult` para o caminho git em `update.ts`). */
export async function runRegistryUpdate(options: RegistryUpdateOptions): Promise<number> {
  let latest: string;
  try {
    latest = await fetchLatestVersion(options.fetchImpl, options.timeoutMs);
  } catch (error) {
    options.stderr(`could not check for updates: ${causeMessage(error)}\n`);
    return 1;
  }

  let comparison: VersionComparison;
  try {
    comparison = compareVersions(options.currentVersion, latest);
  } catch (error) {
    options.stderr(`could not compare versions: ${causeMessage(error)}\n`);
    return 1;
  }

  if (comparison !== "newer") {
    options.stdout(`lohra-ts ${options.currentVersion} is up to date.\n`);
    return 0;
  }

  const args = npmInstallArgs(latest);
  const command = `npm ${args.join(" ")}`;

  if (options.check) {
    options.stdout(
      `lohra-ts ${latest} is available (installed: ${options.currentVersion}) — run \`lohra update --yes\` to install, or \`${command}\`.\n`,
    );
    return 0;
  }

  if (!options.yes) {
    options.stdout(`${command}\n`);
    return 0;
  }

  const installed = options.runner("npm", args, options.cwd);
  if (installed.code !== 0) {
    options.stderr(`npm install failed: ${installed.stderr || installed.stdout}\n`);
    return 1;
  }
  options.stdout(`updated to lohra-ts ${latest}.\n`);
  return 0;
}
