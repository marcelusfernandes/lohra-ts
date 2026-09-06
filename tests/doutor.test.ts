// Issue #63: checagens de `scripts/doutor.ts` (`npm run doutor`). Cada
// checagem recebe um `Executor`/`existe`/`ler` injetável — nenhum teste
// depende do PATH ou do `.git` desta máquina real (AC: "testes unitários
// com exec injetado").
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checarGh,
  checarGitPrePush,
  checarLefthook,
  checarNode,
  checarToolchainNativo,
  type Executor,
  type ResultadoExec,
} from "../scripts/doutor.js";

const workdirs: string[] = [];
afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function novoDir(prefixo: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefixo));
  workdirs.push(dir);
  return dir;
}

function ok(stdout = ""): ResultadoExec {
  return { status: 0, stdout, stderr: "" };
}

function falhaExit(status: number, stderr = ""): ResultadoExec {
  return { status, stdout: "", stderr };
}

function ausente(cmd: string): ResultadoExec {
  return { status: null, stdout: "", stderr: "", error: new Error(`spawn ${cmd} ENOENT`) };
}

describe("checarNode", () => {
  it("Node 20 é ok", () => {
    const c = checarNode("v20.11.0");
    expect(c.status).toBe("ok");
  });

  it("Node 22 é ok", () => {
    const c = checarNode("v22.5.0");
    expect(c.status).toBe("ok");
  });

  it("Node 18 é falta, com o comando de resolução", () => {
    const c = checarNode("v18.20.0");
    expect(c.status).toBe("falta");
    expect(c.comando).toBeDefined();
    expect(c.detalhe).toContain("18");
  });
});

describe("checarToolchainNativo", () => {
  it("fora do Linux, não exige nada (ok sem chamar o exec)", () => {
    const exec: Executor = () => {
      throw new Error("não deveria chamar exec fora do Linux");
    };
    expect(checarToolchainNativo("darwin", exec).status).toBe("ok");
    expect(checarToolchainNativo("win32", exec).status).toBe("ok");
  });

  it("Linux com python3/make/g++ presentes é ok", () => {
    const exec: Executor = () => ok();
    expect(checarToolchainNativo("linux", exec).status).toBe("ok");
  });

  it("Linux faltando g++ é falta e cita g++ no detalhe", () => {
    const exec: Executor = (cmd) => (cmd === "g++" ? ausente(cmd) : ok());
    const c = checarToolchainNativo("linux", exec);
    expect(c.status).toBe("falta");
    expect(c.detalhe).toContain("g++");
    expect(c.detalhe).not.toContain("python3");
  });

  it("Linux faltando os três lista os três", () => {
    const exec: Executor = (cmd) => ausente(cmd);
    const c = checarToolchainNativo("linux", exec);
    expect(c.status).toBe("falta");
    expect(c.detalhe).toContain("python3");
    expect(c.detalhe).toContain("make");
    expect(c.detalhe).toContain("g++");
  });
});

describe("checarGh", () => {
  it("gh ausente do PATH é falta, com brew install no comando", () => {
    const exec: Executor = () => ausente("gh");
    const c = checarGh(exec);
    expect(c.status).toBe("falta");
    expect(c.nome).toBe("gh");
    expect(c.comando).toContain("gh auth login");
  });

  it("gh presente mas não autenticado é falta", () => {
    const exec: Executor = () => falhaExit(1, "You are not logged into any GitHub hosts");
    const c = checarGh(exec);
    expect(c.status).toBe("falta");
    expect(c.comando).toContain("gh auth login");
  });

  it("gh autenticado é ok", () => {
    const exec: Executor = () => ok("Logged in to github.com");
    expect(checarGh(exec).status).toBe("ok");
  });
});

describe("checarGitPrePush", () => {
  it("hooks dir não localizável (git falha) é falta", () => {
    const exec: Executor = () => falhaExit(128, "not a git repository");
    const c = checarGitPrePush(exec, "/nao/existe");
    expect(c.status).toBe("falta");
  });

  it("hook pre-push ausente no hooks dir é falta", () => {
    const raiz = novoDir("doutor-prepush-");
    const exec: Executor = () => ok(join(raiz, ".git", "hooks"));
    const c = checarGitPrePush(exec, raiz, () => false);
    expect(c.status).toBe("falta");
    expect(c.nome).toBe("git-pre-push");
    expect(c.comando).toContain("instalar-git-hooks.sh");
  });

  it("hook pre-push com conteúdo igual ao canônico (.claude/hooks/git-pre-push) é ok", () => {
    const raiz = novoDir("doutor-prepush-");
    const exec: Executor = () => ok(join(raiz, ".git", "hooks"));
    const c = checarGitPrePush(
      exec,
      raiz,
      () => true,
      () => "#!/bin/sh\necho conteudo-canonico\n",
    );
    expect(c.status).toBe("ok");
  });

  it("hook pre-push com conteúdo diferente do canônico é falta, com a dica instalar-git-hooks.sh", () => {
    const raiz = novoDir("doutor-prepush-");
    const exec: Executor = () => ok(join(raiz, ".git", "hooks"));
    const ler = (caminho: string): string =>
      caminho.includes(".claude")
        ? "#!/bin/sh\necho canonico\n"
        : "#!/bin/sh\necho outro-conteudo\n";
    const c = checarGitPrePush(exec, raiz, () => true, ler);
    expect(c.status).toBe("falta");
    expect(c.nome).toBe("git-pre-push");
    expect(c.comando).toContain("instalar-git-hooks.sh");
  });
});

describe("checarLefthook", () => {
  it("hook pre-commit ausente é falta", () => {
    const raiz = novoDir("doutor-lefthook-");
    const exec: Executor = () => ok(join(raiz, ".git", "hooks"));
    const c = checarLefthook(
      exec,
      raiz,
      () => false,
      () => "",
    );
    expect(c.status).toBe("falta");
    expect(c.nome).toBe("lefthook");
  });

  it("pre-commit existe mas não é do lefthook é falta", () => {
    const raiz = novoDir("doutor-lefthook-");
    const exec: Executor = () => ok(join(raiz, ".git", "hooks"));
    const c = checarLefthook(
      exec,
      raiz,
      () => true,
      () => "#!/bin/sh\necho outro hook qualquer\n",
    );
    expect(c.status).toBe("falta");
  });

  it("pre-commit gerenciado pelo lefthook é ok", () => {
    const raiz = novoDir("doutor-lefthook-");
    const hooksDir = join(raiz, ".git", "hooks");
    const exec: Executor = () => ok(hooksDir);
    const c = checarLefthook(
      exec,
      raiz,
      () => true,
      () => '#!/bin/sh\ncall_lefthook run "pre-commit" "$@"\n',
    );
    expect(c.status).toBe("ok");
  });

  it("sem duplos de `existe`/`ler` (padrão real), hooks dir inexistente é falta sem lançar", () => {
    const raiz = novoDir("doutor-lefthook-real-");
    const exec: Executor = () => ok(join(raiz, ".git", "hooks"));
    const c = checarLefthook(exec, raiz);
    expect(c.status).toBe("falta");
  });
});
