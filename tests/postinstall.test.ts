// Issue #63: `scripts/postinstall.mjs` instalava o `git-pre-push` nativo
// (camada 2 da proteção da main) e o `pre-commit` do lefthook — escopado
// ("install pre-commit"), nunca `lefthook install` sem argumento, que
// tocaria (e faria backup de) todos os hooks do `lefthook.yml`, inclusive
// um `pre-push` que viesse a ser declarado lá. É esse escopo — não a ordem
// em que os dois instaladores rodam — que garante que o `pre-push` continua
// sendo o de `.claude/hooks/git-pre-push`.
//
// Emenda de 2026-09-13 (issue #530): esse script fazia MAIS uma coisa —
// `chmod` no `spawn-helper` do `node-pty` — que precisa rodar em QUALQUER
// instalação de consumidor (tarball/registry), nunca só em checkout de dev.
// `prepare` só roda em `npm ci`/`npm install` com `.git` (ou dependência
// git) — nunca em `npm install -g <pacote>` a partir do registry — por isso
// o `chmod` fica em `postinstall` (roda sempre) e a instalação dos hooks
// (git-pre-push + lefthook, que só faz sentido em checkout de dev) migrou
// para `scripts/prepare.mjs`.
//
// Cada teste roda o script real em subprocesso, `cwd` num checkout git
// temporário com duplos de `.claude/hooks/instalar-git-hooks.sh` e
// `node_modules/.bin/lefthook` — nunca no worktree real (git hooks são
// compartilhados entre worktrees; skill `worktree-segura`).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const POSTINSTALL = join(RAIZ, "scripts", "postinstall.mjs");
const PREPARE = join(RAIZ, "scripts", "prepare.mjs");
const GIT_PRE_PUSH_REAL = join(RAIZ, ".claude", "hooks", "git-pre-push");
const INSTALAR_GIT_HOOKS_REAL = join(RAIZ, ".claude", "hooks", "instalar-git-hooks.sh");
const LEFTHOOK_BIN_REAL = join(RAIZ, "node_modules", ".bin", "lefthook");
const LEFTHOOK_YML_REAL = join(RAIZ, "lefthook.yml");

const workdirs: string[] = [];
afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function novoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "postinstall-"));
  workdirs.push(dir);
  return dir;
}

function escreverExecutavel(caminho: string, conteudo: string): void {
  mkdirSync(dirname(caminho), { recursive: true });
  writeFileSync(caminho, conteudo);
  chmodSync(caminho, 0o755);
}

function rodarScript(
  script: string,
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("node", [script], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function gitInit(dir: string): void {
  const r = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git init falhou: ${r.stderr}`);
}

/** Roda um hook (`sh <hook> <args>`) com `entrada` em stdin — o formato que
 * o git usa para chamar `pre-push` de verdade. */
function rodarHook(
  hook: string,
  args: readonly string[],
  entrada: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("sh", [hook, ...args], { input: entrada, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const LINHA_PUSH_MAIN =
  "refs/heads/x 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n";

const INSTALADOR_OK = "#!/bin/sh\necho instalar-git-hooks-chamado\nexit 0\n";
const LEFTHOOK_FAKE = (marcador: string): string =>
  `#!/bin/sh\necho "$@" > "${marcador}"\nexit 0\n`;
/** Ambos os duplos apendam ao mesmo log — prova a ordem determinística de
 * execução do prepare (instalar-git-hooks.sh sempre antes do lefthook). A
 * ordem não é o que protege o `pre-push`: é o escopo de
 * `lefthook install pre-commit`, que nunca toca o hook `pre-push`. */
const INSTALADOR_LOG = (log: string): string => `#!/bin/sh\necho instalar-git-hooks >> "${log}"\n`;
const LEFTHOOK_LOG = (log: string): string => `#!/bin/sh\necho "lefthook $*" >> "${log}"\n`;

function escreverSpawnHelper(dir: string): string {
  const helper = join(
    dir,
    "node_modules",
    "node-pty",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  mkdirSync(dirname(helper), { recursive: true });
  writeFileSync(helper, "#!/bin/sh\nexit 0\n");
  chmodSync(helper, 0o644);
  return helper;
}

describe("postinstall.mjs — chmod do spawn-helper do node-pty (issue #530)", () => {
  it("sem o spawn-helper presente, não faz nada e sai 0", () => {
    const dir = novoDir();
    const r = rodarScript(POSTINSTALL, dir);
    expect(r.status).toBe(0);
  });

  it("com o spawn-helper presente, torna-o executável — mesmo sem .git (tarball)", () => {
    if (process.platform === "win32") return;
    const dir = novoDir();
    const helper = escreverSpawnHelper(dir);
    const r = rodarScript(POSTINSTALL, dir);
    expect(r.status).toBe(0);
    const modo = statSync(helper).mode & 0o777;
    expect(modo).toBe(0o755);
  });

  it("não instala hooks de git nem lefthook, mesmo com .git presente", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    escreverExecutavel(join(dir, ".claude", "hooks", "instalar-git-hooks.sh"), INSTALADOR_OK);
    const r = rodarScript(POSTINSTALL, dir);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("instalar-git-hooks-chamado");
  });
});

describe("prepare.mjs — git-pre-push (comportamento existente, migrado do postinstall)", () => {
  it("sem .git (instalação por tarball) não roda nada e sai 0", () => {
    const dir = novoDir();
    const r = rodarScript(PREPARE, dir);
    expect(r.status).toBe(0);
  });

  it("chama instalar-git-hooks.sh quando .git existe", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    escreverExecutavel(join(dir, ".claude", "hooks", "instalar-git-hooks.sh"), INSTALADOR_OK);
    const r = rodarScript(PREPARE, dir);
    expect(r.status).toBe(0);
    // stdout do instalador vai para o stderr do prepare (ver comentário em
    // scripts/prepare.mjs) — nunca para o stdout, que ferramentas como
    // `npm pack --json` esperam limpo.
    expect(r.stdout).not.toContain("instalar-git-hooks-chamado");
    expect(r.stderr).toContain("instalar-git-hooks-chamado");
  });
});

describe("prepare.mjs — pre-commit do lefthook (issue #63)", () => {
  it("chama `lefthook install pre-commit` quando o binário está instalado", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    const marcador = join(dir, "lefthook-chamado-com.txt");
    escreverExecutavel(join(dir, "node_modules", ".bin", "lefthook"), LEFTHOOK_FAKE(marcador));
    const r = rodarScript(PREPARE, dir);
    expect(r.status).toBe(0);
    expect(existsSync(marcador)).toBe(true);
    expect(readFileSync(marcador, "utf8").trim()).toBe("install pre-commit");
  });

  it('nunca chama `lefthook install` sem escopo (só "pre-commit")', () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    const marcador = join(dir, "lefthook-chamado-com.txt");
    escreverExecutavel(join(dir, "node_modules", ".bin", "lefthook"), LEFTHOOK_FAKE(marcador));
    rodarScript(PREPARE, dir);
    const args = readFileSync(marcador, "utf8").trim();
    expect(args).not.toBe("install");
    expect(args.split(/\s+/u)).toEqual(["install", "pre-commit"]);
  });

  it("sem o binário instalado (produção, --omit=dev), pula em silêncio e sai 0", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    const r = rodarScript(PREPARE, dir);
    expect(r.status).toBe(0);
  });

  it("lefthook install falhando não derruba o prepare (não é a única barreira)", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    escreverExecutavel(join(dir, "node_modules", ".bin", "lefthook"), "#!/bin/sh\nexit 1\n");
    const r = rodarScript(PREPARE, dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("lefthook install pre-commit falhou");
  });

  it("instalar-git-hooks.sh sempre roda ANTES do lefthook install (só determinismo — o escopo `pre-commit` é o que protege o pre-push)", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    const log = join(dir, "ordem.log");
    escreverExecutavel(join(dir, ".claude", "hooks", "instalar-git-hooks.sh"), INSTALADOR_LOG(log));
    escreverExecutavel(join(dir, "node_modules", ".bin", "lefthook"), LEFTHOOK_LOG(log));
    const r = rodarScript(PREPARE, dir);
    expect(r.status).toBe(0);
    const linhas = readFileSync(log, "utf8").trim().split("\n");
    expect(linhas).toEqual(["instalar-git-hooks", "lefthook install pre-commit"]);
  });
});

describe("prepare.mjs — integração real (hooks de verdade, git-pre-push + lefthook)", () => {
  it("`git-pre-push` real fica instalado e recusa push para main (pipe-test)", () => {
    const dir = novoDir();
    gitInit(dir);
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    copyFileSync(GIT_PRE_PUSH_REAL, join(dir, ".claude", "hooks", "git-pre-push"));
    copyFileSync(INSTALAR_GIT_HOOKS_REAL, join(dir, ".claude", "hooks", "instalar-git-hooks.sh"));
    chmodSync(join(dir, ".claude", "hooks", "instalar-git-hooks.sh"), 0o755);

    const r = rodarScript(PREPARE, dir);
    expect(r.status).toBe(0);

    const prePush = join(dir, ".git", "hooks", "pre-push");
    expect(existsSync(prePush)).toBe(true);
    expect(readFileSync(prePush, "utf8")).toBe(readFileSync(GIT_PRE_PUSH_REAL, "utf8"));

    const push = rodarHook(prePush, ["origin", "https://example.invalid/x.git"], LINHA_PUSH_MAIN);
    expect(push.status).toBe(1);
    expect(push.stderr).toContain("proibido");
  });

  it.skipIf(!existsSync(LEFTHOOK_BIN_REAL))(
    "com o lefthook de verdade instalado (devDependency, CI/npm ci), pre-commit fica gerenciado e pre-push continua recusando main",
    () => {
      const dir = novoDir();
      gitInit(dir);
      mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
      copyFileSync(GIT_PRE_PUSH_REAL, join(dir, ".claude", "hooks", "git-pre-push"));
      copyFileSync(INSTALAR_GIT_HOOKS_REAL, join(dir, ".claude", "hooks", "instalar-git-hooks.sh"));
      chmodSync(join(dir, ".claude", "hooks", "instalar-git-hooks.sh"), 0o755);
      // lefthook.yml de verdade: sem config, `lefthook install pre-commit`
      // cria um `lefthook.yml` de exemplo (tudo comentado) e não instala hook
      // nenhum — só "sync hooks" sem sufixo `(pre-commit)`. Sem isto o teste
      // passaria por acidente (achado rodando a integração de verdade).
      copyFileSync(LEFTHOOK_YML_REAL, join(dir, "lefthook.yml"));
      // Symlink, não cópia: o binário do lefthook resolve seus pacotes de
      // plataforma (lefthook-darwin-arm64 etc.) por caminho relativo à sua
      // própria localização real — o Node segue o link antes de resolver
      // `require`, então isto continua achando o node_modules verdadeiro.
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      symlinkSync(LEFTHOOK_BIN_REAL, join(dir, "node_modules", ".bin", "lefthook"));

      const r = rodarScript(PREPARE, dir);
      expect(r.status).toBe(0);

      const preCommit = join(dir, ".git", "hooks", "pre-commit");
      expect(existsSync(preCommit)).toBe(true);
      expect(readFileSync(preCommit, "utf8").toLowerCase()).toContain("lefthook");

      const prePush = join(dir, ".git", "hooks", "pre-push");
      expect(readFileSync(prePush, "utf8")).toBe(readFileSync(GIT_PRE_PUSH_REAL, "utf8"));
      const push = rodarHook(prePush, ["origin", "https://example.invalid/x.git"], LINHA_PUSH_MAIN);
      expect(push.status).toBe(1);
    },
  );
});
