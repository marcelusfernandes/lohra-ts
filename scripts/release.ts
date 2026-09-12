#!/usr/bin/env node
// scripts/release.ts — `npm run release -- <patch|minor|major|x.y.z>` (issue
// #531/D2). Sem rede: usa `git log --merges` deste repositório, nunca `gh`
// nem `gh api` (contrato da issue). Fluxo completo em `docs/release.md`.
//
// `runRelease` (via `planRelease`) faz TODAS as validações e leituras — a
// fase de COMPUTE — antes de qualquer escrita em disco ou no git (fail-
// closed: nada muda se qualquer uma reprovar):
//   1. árvore de trabalho limpa (`git status --porcelain` vazio);
//   2. argumento de versão válido (`patch`/`minor`/`major`/`x.y.z`);
//   3. a versão-alvo é maior que a atual (`RELEASE_VERSION_NOT_GREATER` —
//      só se aplica ao `x.y.z` explícito; bump sempre soma 1 em algum
//      componente);
//   4. branch atual é exatamente `release/<versão-alvo>` — nunca `main`
//      (causa própria `RELEASE_BRANCH_MAIN`) nem qualquer outra branch
//      (`RELEASE_BRANCH_MISMATCH`);
//   5. `CHANGELOG.md` existente (se houver) começa exatamente por
//      `# Changelog\n` — senão `RELEASE_CHANGELOG_HEADER_UNEXPECTED`, para
//      nunca descartar conteúdo (achado do revisor na PR #546, rodada 1).
//
// Só depois da fase de COMPUTE inteira ter sucesso é que a fase WRITE roda:
// bump em `package.json` e, se existir, `package-lock.json` (só as duas
// ocorrências do pacote raiz — `version` de topo e `packages[""].version`
// — nunca as `version` de dependências aninhadas); a seção nova do
// `CHANGELOG.md` (gerada a partir dos merges `--first-parent` desde a
// última tag `v*`, ou desde o início se não houver tag nenhuma) entra no
// topo do arquivo, acima do que já existia; tudo commitado como
// `chore(release): v<versão>`. NUNCA cria tag — isso é do owner ou do
// workflow de D7, sobre o merge commit da PR de release (`docs/release.md`).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export type BumpKind = "patch" | "minor" | "major";

export type ParsedVersionArg =
  | { readonly kind: "bump"; readonly bump: BumpKind }
  | { readonly kind: "explicit"; readonly version: string };

export interface MergedPr {
  readonly number: string | null;
  readonly title: string;
}

export interface RunReleaseOptions {
  readonly cwd: string;
  readonly arg: string | undefined;
  readonly now?: Date;
}

export interface RunReleaseResult {
  readonly version: string;
  readonly previousVersion: string;
  readonly changelogSection: string;
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function parseVersionArg(arg: string | undefined): ParsedVersionArg {
  if (arg === "patch" || arg === "minor" || arg === "major") return { kind: "bump", bump: arg };
  if (arg !== undefined && SEMVER_RE.test(arg)) return { kind: "explicit", version: arg };
  const recebido = arg === undefined ? "(nenhum argumento)" : arg;
  throw new Error(`RELEASE_INVALID_VERSION:${recebido} — use patch|minor|major ou x.y.z`);
}

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseSemver(version: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const majorText = match?.[1];
  const minorText = match?.[2];
  const patchText = match?.[3];
  if (majorText === undefined || minorText === undefined || patchText === undefined) return null;
  return { major: Number(majorText), minor: Number(minorText), patch: Number(patchText) };
}

export function computeNextVersion(currentVersion: string, parsed: ParsedVersionArg): string {
  if (parsed.kind === "explicit") return parsed.version;
  const current = parseSemver(currentVersion);
  if (current === null) throw new Error(`RELEASE_INVALID_CURRENT_VERSION:${currentVersion}`);
  if (parsed.bump === "major") return `${String(current.major + 1)}.0.0`;
  if (parsed.bump === "minor") return `${String(current.major)}.${String(current.minor + 1)}.0`;
  return `${String(current.major)}.${String(current.minor)}.${String(current.patch + 1)}`;
}

/**
 * Recusa regressão de versão: `x.y.z` explícito ≤ à versão atual (bump
 * `patch`/`minor`/`major` sempre soma 1 em algum componente e nunca cai
 * aqui — a checagem só existe para o caso explícito). Achado do revisor na
 * PR #546, rodada 1: `computeNextVersion("0.0.11", "0.0.1")` devolvia
 * `"0.0.1"` sem recusa nenhuma; só o nome da branch (`release/0.0.1`, que o
 * operador também controla) impedia a regressão de verdade.
 */
export function assertVersionIsGreater(currentVersion: string, targetVersion: string): void {
  const current = parseSemver(currentVersion);
  const target = parseSemver(targetVersion);
  if (current === null) throw new Error(`RELEASE_INVALID_CURRENT_VERSION:${currentVersion}`);
  if (target === null) throw new Error(`RELEASE_INVALID_CURRENT_VERSION:${targetVersion}`);
  const isGreater =
    target.major !== current.major
      ? target.major > current.major
      : target.minor !== current.minor
        ? target.minor > current.minor
        : target.patch > current.patch;
  if (!isGreater) {
    throw new Error(`RELEASE_VERSION_NOT_GREATER:${targetVersion}:current:${currentVersion}`);
  }
}

interface GitOutcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

// `SpawnSyncReturns<string>.stdout`/`.stderr` são tipados como sempre
// `string` em `@types/node`, mas quando o processo nem chega a rodar
// (ENOENT — `git` ausente do `PATH`) o Node devolve `undefined` de
// verdade. O cast é o que torna o fallback necessário aos olhos do
// `no-unnecessary-condition` (mesmo idioma de `scripts/provenance/check-ancestry.ts`).
function textoOuVazio(valor: string | undefined): string {
  return valor ?? "";
}

function runGit(cwd: string, args: readonly string[]): GitOutcome {
  const result = spawnSync("git", args as string[], { cwd, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: textoOuVazio(result.stdout),
    stderr: textoOuVazio(result.stderr),
  };
}

export function isTreeClean(cwd: string): boolean {
  return runGit(cwd, ["status", "--porcelain"]).stdout.trim() === "";
}

export function currentBranch(cwd: string): string {
  return runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
}

export function validateReleaseBranch(branch: string, targetVersion: string): void {
  if (branch === "main") throw new Error("RELEASE_BRANCH_MAIN:recusa rodar em main");
  const expected = `release/${targetVersion}`;
  if (branch !== expected) {
    throw new Error(`RELEASE_BRANCH_MISMATCH:${branch}:esperava:${expected}`);
  }
}

export function lastReleaseTag(cwd: string): string | null {
  const outcome = runGit(cwd, ["tag", "--list", "v*", "--sort=-v:refname"]);
  const lines = outcome.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines[0] ?? null;
}

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";
const PR_NUMBER_RE = /#(\d+)/;

/**
 * Merges alcançáveis por `--first-parent` (a cadeia principal da branch —
 * exatamente os merge commits de PR em `main`, nunca os merges internos de
 * uma feature branch com `origin/main` do passo 10c do fluxo de git) desde
 * `sinceTag` (exclusive) até `HEAD`, ou desde o início se `sinceTag` for
 * `null`. Sem rede: só `git log` local — nunca `gh`/`gh api`.
 */
export function mergesSince(cwd: string, sinceTag: string | null): readonly MergedPr[] {
  const range = sinceTag !== null ? `${sinceTag}..HEAD` : "HEAD";
  const outcome = runGit(cwd, [
    "log",
    "--first-parent",
    "--merges",
    `--format=%s${FIELD_SEP}%b${RECORD_SEP}`,
    range,
  ]);
  const records = outcome.stdout
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter((record) => record !== "");
  return records.map((record) => {
    const [subjectRaw, bodyRaw] = record.split(FIELD_SEP);
    const subject = subjectRaw ?? "";
    const body = bodyRaw ?? "";
    const numberMatch = PR_NUMBER_RE.exec(subject) ?? PR_NUMBER_RE.exec(body);
    // `# Conflicts:` (+ os caminhos, prefixados por `#`) é o bloco que o
    // próprio `git merge` anexa ao corpo quando o merge teve conflito
    // resolvido manualmente — nunca um título de verdade. `#` é comentário
    // de mensagem de commit por convenção do git; ignorado aqui do mesmo
    // jeito.
    const bodyFirstLine = body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("#"));
    return { number: numberMatch?.[1] ?? null, title: bodyFirstLine ?? subject };
  });
}

// Grupo derivado do prefixo de conventional commit no TÍTULO — a única
// coisa disponível sem rede (sem `gh api`, não há milestone para agrupar
// por aqui; agrupar pelo tipo do título é o que "agrupe por título, sem
// inventar" pede).
const TYPE_SECTIONS: Record<string, string> = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  docs: "Docs",
  test: "Tests",
  chore: "Chore",
  ci: "CI",
};
const SECTION_ORDER = [
  "Added",
  "Fixed",
  "Changed",
  "Docs",
  "Tests",
  "Chore",
  "CI",
  "Other",
] as const;
const CONVENTIONAL_TYPE_RE = /^([a-z]+)(\([^)]*\))?!?:/;

function sectionFor(title: string): string {
  const type = CONVENTIONAL_TYPE_RE.exec(title)?.[1];
  if (type === undefined) return "Other";
  return TYPE_SECTIONS[type] ?? "Other";
}

export function buildChangelogSection(
  version: string,
  prs: readonly MergedPr[],
  dateIso: string,
): string {
  const groups = new Map<string, MergedPr[]>();
  for (const pr of prs) {
    const section = sectionFor(pr.title);
    groups.set(section, [...(groups.get(section) ?? []), pr]);
  }
  const lines: string[] = [`## [${version}] - ${dateIso}`, ""];
  for (const section of SECTION_ORDER) {
    const items = groups.get(section);
    if (items === undefined || items.length === 0) continue;
    lines.push(`### ${section}`, "");
    for (const item of items) {
      const prRef = item.number !== null ? ` (#${item.number})` : "";
      lines.push(`- ${item.title}${prRef}`);
    }
    lines.push("");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

const CHANGELOG_HEADER = "# Changelog\n";

/**
 * Insere `section` logo após o cabeçalho `# Changelog` — sempre a versão
 * mais recente no topo. `existing === ""` (arquivo ainda não existe) cria o
 * cabeçalho. Fora isso, `existing` precisa começar EXATAMENTE por
 * `# Changelog\n` — NUNCA descarta conteúdo: um `existing` não-vazio com
 * cabeçalho diferente (título com sufixo, badge, CRLF) lança
 * `RELEASE_CHANGELOG_HEADER_UNEXPECTED` em vez de devolver só o cabeçalho +
 * a seção nova. Achado do revisor na PR #546, rodada 1: o ramo antigo
 * jogava fora as ~250 entradas existentes sem log nem throw quando o
 * cabeçalho não batia byte a byte (fail-closed — CLAUDE.md invariante 2).
 * `runRelease` chama esta função ANTES de escrever `package.json`/
 * `package-lock.json` — a recusa aqui não deixa nada parcialmente alterado.
 */
export function insertChangelogSection(existing: string, section: string): string {
  const trimmedSection = section.replace(/\n+$/, "\n");
  if (existing === "") {
    return `${CHANGELOG_HEADER}\n${trimmedSection}`;
  }
  if (!existing.startsWith(CHANGELOG_HEADER)) {
    throw new Error(
      'RELEASE_CHANGELOG_HEADER_UNEXPECTED:CHANGELOG.md não começa exatamente por "# Changelog\\n"',
    );
  }
  const rest = existing.slice(CHANGELOG_HEADER.length).replace(/^\n+/, "");
  return rest === ""
    ? `${CHANGELOG_HEADER}\n${trimmedSection}`
    : `${CHANGELOG_HEADER}\n${trimmedSection}\n${rest}`;
}

/** Bump imutável: nunca muta `lock` — devolve uma cópia nova. Só toca as
 * duas ocorrências do pacote raiz (`version` de topo e
 * `packages[""].version`); qualquer outra entrada de `packages` (as
 * dependências) fica intacta. */
export function bumpLockVersion(
  lock: Record<string, unknown>,
  version: string,
): Record<string, unknown> {
  const packages = lock["packages"];
  if (typeof packages !== "object" || packages === null) {
    return { ...lock, version };
  }
  const packagesRecord = packages as Record<string, unknown>;
  const rootPackage = packagesRecord[""];
  if (typeof rootPackage !== "object" || rootPackage === null) {
    return { ...lock, version, packages: packagesRecord };
  }
  return {
    ...lock,
    version,
    packages: {
      ...packagesRecord,
      "": { ...(rootPackage as Record<string, unknown>), version },
    },
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Fase 1 (COMPUTE): validações + leituras + toda a construção de conteúdo
// novo — nada escreve em disco nem no git aqui, e `insertChangelogSection`
// pode lançar `RELEASE_CHANGELOG_HEADER_UNEXPECTED`. Fase 2 (WRITE), logo
// abaixo em `runRelease`, só roda depois que a fase 1 inteira teve sucesso —
// é o que garante que uma recusa (qualquer uma, inclusive a do cabeçalho do
// CHANGELOG) nunca deixa `package.json`/`package-lock.json`/`CHANGELOG.md`
// parcialmente alterados (achado do revisor na PR #546, rodada 1).
interface ReleasePlan {
  readonly targetVersion: string;
  readonly currentVersion: string;
  readonly packageJson: Record<string, unknown>;
  readonly updatedLock: Record<string, unknown> | null;
  readonly updatedChangelog: string;
  readonly changelogSection: string;
}

function planRelease(cwd: string, arg: string | undefined, now: Date): ReleasePlan {
  if (!isTreeClean(cwd)) throw new Error("RELEASE_TREE_DIRTY:árvore de trabalho suja");

  const parsed = parseVersionArg(arg);

  const packageJsonPath = join(cwd, "package.json");
  const packageJson = readJson(packageJsonPath) as Record<string, unknown>;
  const currentVersion = packageJson["version"];
  if (typeof currentVersion !== "string") {
    throw new Error('RELEASE_PACKAGE_JSON_VERSION_MISSING:package.json sem "version" string');
  }
  const targetVersion = computeNextVersion(currentVersion, parsed);
  assertVersionIsGreater(currentVersion, targetVersion);

  validateReleaseBranch(currentBranch(cwd), targetVersion);

  const sinceTag = lastReleaseTag(cwd);
  const merges = mergesSince(cwd, sinceTag);
  const changelogSection = buildChangelogSection(targetVersion, merges, isoDate(now));

  const lockPath = join(cwd, "package-lock.json");
  const updatedLock = existsSync(lockPath)
    ? bumpLockVersion(readJson(lockPath) as Record<string, unknown>, targetVersion)
    : null;

  const changelogPath = join(cwd, "CHANGELOG.md");
  const existingChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  const updatedChangelog = insertChangelogSection(existingChangelog, changelogSection);

  return {
    targetVersion,
    currentVersion,
    packageJson,
    updatedLock,
    updatedChangelog,
    changelogSection,
  };
}

export function runRelease(options: RunReleaseOptions): RunReleaseResult {
  const { cwd } = options;
  const plan = planRelease(cwd, options.arg, options.now ?? new Date());

  writeJson(join(cwd, "package.json"), { ...plan.packageJson, version: plan.targetVersion });

  const touchedPaths = ["package.json", "CHANGELOG.md"];
  if (plan.updatedLock !== null) {
    writeJson(join(cwd, "package-lock.json"), plan.updatedLock);
    touchedPaths.push("package-lock.json");
  }
  writeFileSync(join(cwd, "CHANGELOG.md"), plan.updatedChangelog);

  const addOutcome = runGit(cwd, ["add", ...touchedPaths]);
  if (addOutcome.status !== 0) throw new Error(`RELEASE_GIT_ADD_FAILED:${addOutcome.stderr}`);

  const commitOutcome = runGit(cwd, ["commit", "-m", `chore(release): v${plan.targetVersion}`]);
  if (commitOutcome.status !== 0) {
    throw new Error(`RELEASE_COMMIT_FAILED:${commitOutcome.stderr}`);
  }

  return {
    version: plan.targetVersion,
    previousVersion: plan.currentVersion,
    changelogSection: plan.changelogSection,
  };
}

function main(): void {
  const arg = process.argv[2];
  try {
    const result = runRelease({ cwd: process.cwd(), arg });
    process.stdout.write(`release: v${result.previousVersion} -> v${result.version}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release: ${message}\n`);
    process.exit(1);
  }
}

// Só roda `main()` quando este arquivo é o entry point (`tsx
// scripts/release.ts`, via `npm run release`) — nunca quando um teste
// importa as funções puras diretamente (mesmo idioma de
// `scripts/provenance/check-ancestry.ts`).
function ehEntryPoint(): boolean {
  const invocado = process.argv[1];
  if (invocado === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(invocado)).href;
}

if (ehEntryPoint()) {
  main();
}
