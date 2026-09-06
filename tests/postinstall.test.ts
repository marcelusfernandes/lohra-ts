// Issue #63: `scripts/postinstall.mjs` continua instalando o `git-pre-push`
// nativo (camada 2 da proteção da main) e passa a instalar também o hook
// `pre-commit` do lefthook — escopado ("install pre-commit"), nunca
// `lefthook install` sem argumento, que sobrescreveria o `pre-push` recém
// instalado. Cada teste roda o script real em subprocesso, `cwd` num
// checkout git temporário com duplos de `.claude/hooks/instalar-git-hooks.sh`
// e `node_modules/.bin/lefthook` — nunca no worktree real (git hooks são
// compartilhados entre worktrees; skill `worktree-segura`).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const POSTINSTALL = fileURLToPath(new URL("../scripts/postinstall.mjs", import.meta.url));

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

function rodarPostinstall(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("node", [POSTINSTALL], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const INSTALADOR_OK = "#!/bin/sh\necho instalar-git-hooks-chamado\nexit 0\n";
const LEFTHOOK_FAKE = (marcador: string): string =>
  `#!/bin/sh\necho "$@" > "${marcador}"\nexit 0\n`;

describe("postinstall.mjs — sem .git (instalação por tarball)", () => {
  it("não roda nada e sai 0", () => {
    const dir = novoDir();
    const r = rodarPostinstall(dir);
    expect(r.status).toBe(0);
  });
});

describe("postinstall.mjs — git-pre-push (comportamento existente)", () => {
  it("chama instalar-git-hooks.sh quando .git existe", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    escreverExecutavel(join(dir, ".claude", "hooks", "instalar-git-hooks.sh"), INSTALADOR_OK);
    const r = rodarPostinstall(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("instalar-git-hooks-chamado");
  });
});

describe("postinstall.mjs — pre-commit do lefthook (issue #63)", () => {
  it("chama `lefthook install pre-commit` quando o binário está instalado", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    const marcador = join(dir, "lefthook-chamado-com.txt");
    escreverExecutavel(join(dir, "node_modules", ".bin", "lefthook"), LEFTHOOK_FAKE(marcador));
    const r = rodarPostinstall(dir);
    expect(r.status).toBe(0);
    expect(existsSync(marcador)).toBe(true);
    expect(readFileSync(marcador, "utf8").trim()).toBe("install pre-commit");
  });

  it('nunca chama `lefthook install` sem escopo (só "pre-commit")', () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    const marcador = join(dir, "lefthook-chamado-com.txt");
    escreverExecutavel(join(dir, "node_modules", ".bin", "lefthook"), LEFTHOOK_FAKE(marcador));
    rodarPostinstall(dir);
    const args = readFileSync(marcador, "utf8").trim();
    expect(args).not.toBe("install");
    expect(args.split(/\s+/u)).toEqual(["install", "pre-commit"]);
  });

  it("sem o binário instalado (produção, --omit=dev), pula em silêncio e sai 0", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    const r = rodarPostinstall(dir);
    expect(r.status).toBe(0);
  });

  it("lefthook install falhando não derruba o postinstall (não é a única barreira)", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    escreverExecutavel(join(dir, "node_modules", ".bin", "lefthook"), "#!/bin/sh\nexit 1\n");
    const r = rodarPostinstall(dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("lefthook install pre-commit falhou");
  });

  it("git-pre-push e lefthook instalados juntos: o pre-push não é sobrescrito", () => {
    const dir = novoDir();
    mkdirSync(join(dir, ".git"));
    escreverExecutavel(join(dir, ".claude", "hooks", "instalar-git-hooks.sh"), INSTALADOR_OK);
    const marcador = join(dir, "lefthook-chamado-com.txt");
    escreverExecutavel(join(dir, "node_modules", ".bin", "lefthook"), LEFTHOOK_FAKE(marcador));
    const r = rodarPostinstall(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("instalar-git-hooks-chamado");
    expect(readFileSync(marcador, "utf8").trim()).toBe("install pre-commit");
  });
});
