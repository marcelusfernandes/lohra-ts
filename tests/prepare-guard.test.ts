// Issue #544 (D9 do épico #529, follow-up de #530/PR #541): `npm pack
// --dry-run --json` roda o lifecycle `prepare` mesmo com `--ignore-scripts`
// (comportamento do npm 10, verificado pelo revisor na PR #541) — então
// `tests/package-manifest.test.ts` e `scripts/pack-check.ts`, ao rodarem
// `npm pack`, instalavam os hooks de git no checkout real a cada corrida.
// `scripts/prepare.mjs` ganha um guard por variável de ambiente
// (`LOHRA_SKIP_PREPARE=1`) que os dois chamadores setam — este arquivo prova
// o guard isoladamente, num repo git temporário (nunca no worktree real: git
// hooks são compartilhados entre worktrees, skill `worktree-segura`).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const PREPARE = join(RAIZ, "scripts", "prepare.mjs");
const GIT_PRE_PUSH_REAL = join(RAIZ, ".claude", "hooks", "git-pre-push");
const INSTALAR_GIT_HOOKS_REAL = join(RAIZ, ".claude", "hooks", "instalar-git-hooks.sh");

const workdirs: string[] = [];
afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function novoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prepare-guard-"));
  workdirs.push(dir);
  return dir;
}

function gitInit(dir: string): void {
  const r = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git init falhou: ${r.stderr}`);
}

/** Repo git temporário com os duplos reais de `git-pre-push` +
 * `instalar-git-hooks.sh` — o mesmo cenário de integração de
 * `tests/postinstall.test.ts`, para o guard ser provado contra o
 * comportamento de verdade, não um duplo do instalador. */
function repoComHooksReais(): string {
  const dir = novoDir();
  gitInit(dir);
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  copyFileSync(GIT_PRE_PUSH_REAL, join(dir, ".claude", "hooks", "git-pre-push"));
  copyFileSync(INSTALAR_GIT_HOOKS_REAL, join(dir, ".claude", "hooks", "instalar-git-hooks.sh"));
  return dir;
}

function rodarPrepare(
  dir: string,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("node", [PREPARE], { cwd: dir, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("scripts/prepare.mjs — guard LOHRA_SKIP_PREPARE (issue #544)", () => {
  it("com LOHRA_SKIP_PREPARE=1, não instala nenhum hook e avisa no stderr que pulou", () => {
    const dir = repoComHooksReais();
    const r = rodarPrepare(dir, { ...process.env, LOHRA_SKIP_PREPARE: "1" });
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, ".git", "hooks", "pre-push"))).toBe(false);
    expect(r.stderr).toContain("prepare: pulado (LOHRA_SKIP_PREPARE=1)");
  });

  it("sem a variável, instala o pre-push nativo (comportamento atual, contra-asserção)", () => {
    const dir = repoComHooksReais();
    // Constrói o env sem herdar LOHRA_SKIP_PREPARE do processo pai: quem
    // roda os testes com a variável já setada globalmente (ex.: um shell de
    // CI que a usa para o próprio `npm ci`) não pode fazer esta
    // contra-asserção falhar por um motivo alheio ao código.
    const semGuard = { ...process.env };
    delete semGuard.LOHRA_SKIP_PREPARE;
    const r = rodarPrepare(dir, semGuard);
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, ".git", "hooks", "pre-push"))).toBe(true);
    expect(r.stderr).not.toContain("prepare: pulado");
  });

  it('LOHRA_SKIP_PREPARE com valor diferente de "1" não ativa o guard', () => {
    const dir = repoComHooksReais();
    const r = rodarPrepare(dir, { ...process.env, LOHRA_SKIP_PREPARE: "0" });
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, ".git", "hooks", "pre-push"))).toBe(true);
  });
});
