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

/** Consulta `registry.npmjs.org/lohra-ts/latest` com timeout curto e sem
 * retry. Qualquer desvio do caminho feliz (rede fora, status não-ok, corpo
 * sem `version` string) lança com a causa nomeada. */
export function fetchLatestVersion(
  _fetchImpl: RegistryFetch,
  _timeoutMs: number = REGISTRY_TIMEOUT_MS,
): Promise<string> {
  throw new Error("not implemented: fetchLatestVersion");
}

/** Compara duas versões `x.y.z` (só três partes numéricas — sem pré-release,
 * sem build metadata). Versão que não casa esse formato é fail-closed: lança
 * em vez de adivinhar uma ordem. */
export function compareVersions(_current: string, _latest: string): VersionComparison {
  throw new Error("not implemented: compareVersions");
}

/** `npm install -g lohra-ts@<version>` como executable + argv — nunca uma
 * string de shell. */
export function npmInstallArgs(_version: string): readonly string[] {
  throw new Error("not implemented: npmInstallArgs");
}

/** Versão do próprio pacote instalado, lida do `package.json` que acompanha
 * o módulo em disco (não de uma constante) — dois níveis acima de
 * `src/commands/` ou `dist/commands/`, que é a raiz do pacote nos dois
 * casos. */
export function readInstalledVersion(_moduleUrl: string = import.meta.url): string {
  throw new Error("not implemented: readInstalledVersion");
}

/** Orquestra o contrato inteiro de `lohra update` fora de um checkout git:
 * consulta o registry, compara com a versão instalada, e — só com
 * `options.yes` — executa `npm install -g lohra-ts@<latest>` por
 * executable/argv (sem shell). Sem `options.yes`, imprime o comando exato
 * em stdout e sai 0. Retorna o exit code (0 ou 1 — nunca 2, que é o código
 * de `writeResult` para o caminho git em `update.ts`). */
export function runRegistryUpdate(_options: RegistryUpdateOptions): Promise<number> {
  throw new Error("not implemented: runRegistryUpdate");
}

// Referências mantidas para o typecheck não acusar imports não usados
// enquanto os corpos acima são stubs — removidas quando a implementação
// real usar `readFileSync`/`dirname`/`resolve`/`fileURLToPath` de verdade.
void readFileSync;
void dirname;
void resolve;
void fileURLToPath;
