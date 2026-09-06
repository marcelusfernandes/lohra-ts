// Bancada do hook PreToolUse(Bash) `.claude/hooks/protege-main.sh` (issue #61).
//
// Cada caso invoca o hook em subprocesso com um payload sintético de chamada Bash
// e afirma o exit code (0 = permite, 2 = nega) e o motivo no stderr. O hook
// consulta `git` (branch atual) e `gh` (checks, labels, arquivos da PR); sob
// `LOHRA_BENCH=1` — o único portão — as seams `LOHRA_PM_BRANCH`,
// `LOHRA_PM_CHECKS_JSON` e `LOHRA_PM_VIEW_JSON` substituem essas consultas. Sem
// o portão nenhuma seam é lida e o hook consulta os binários de verdade.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(new URL("../.claude/hooks/protege-main.sh", import.meta.url));

interface HookRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

function limparAmbiente(): Record<string, string> {
  const limpo: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      k === "LOHRA_BENCH" ||
      k.startsWith("LOHRA_PM_") ||
      k === "LOHRA_PERMITE_PUSH_MAIN" ||
      k === "LOHRA_MERGE_LIVRE"
    )
      continue;
    limpo[k] = v;
  }
  return limpo;
}

function rodar(root: string, command: string, env: Record<string, string>): HookRun {
  const r = spawnSync("sh", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: root }),
    encoding: "utf8",
    env: { ...limparAmbiente(), ...env },
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

const CHECKS_VERDES = JSON.stringify([
  { name: "checks (20)", state: "SUCCESS" },
  { name: "provenance", state: "SUCCESS" },
]);
const CHECKS_VERMELHOS = JSON.stringify([
  { name: "checks (20)", state: "FAILURE" },
  { name: "provenance", state: "SUCCESS" },
]);

function view(labels: readonly string[], files: readonly string[], changedFiles?: number): string {
  return JSON.stringify({
    labels: labels.map((name) => ({ name })),
    reviewDecision: "",
    changedFiles: changedFiles ?? files.length,
    files: files.map((p) => ({ path: p })),
  });
}

function bench(extra: Record<string, string> = {}): Record<string, string> {
  return {
    LOHRA_BENCH: "1",
    LOHRA_PM_BRANCH: "feat/1-x",
    LOHRA_PM_CHECKS_JSON: CHECKS_VERDES,
    LOHRA_PM_VIEW_JSON: view(["review:approved"], ["src/x.ts"]),
    ...extra,
  };
}

describe("protege-main.sh", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "protege-main-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("git push", () => {
    it("push normal para branch de issue: permite", () => {
      expect(rodar(root, "git push -u origin feat/1-x", bench()).status).toBe(0);
    });

    it("push forçado: nega sem válvula", () => {
      const r = rodar(
        root,
        "git push --force origin feat/1-x",
        bench({ LOHRA_PERMITE_PUSH_MAIN: "1" }),
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/forçado/u);
    });

    it("HEAD:main: nega", () => {
      const r = rodar(root, "git push origin HEAD:main", bench());
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/main/u);
    });

    it(":main apaga a branch remota: nega", () => {
      const r = rodar(root, "git push origin :main", bench());
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/apagar/u);
    });

    it("push sem refspec a partir de main: nega; com LOHRA_PERMITE_PUSH_MAIN=1: permite", () => {
      expect(rodar(root, "git push", bench({ LOHRA_PM_BRANCH: "main" })).status).toBe(2);
      expect(
        rodar(root, "git push", bench({ LOHRA_PM_BRANCH: "main", LOHRA_PERMITE_PUSH_MAIN: "1" }))
          .status,
      ).toBe(0);
    });

    it("--all e --mirror empurram main junto: nega", () => {
      expect(rodar(root, "git push --all origin", bench()).status).toBe(2);
      expect(rodar(root, "git push --mirror origin", bench()).status).toBe(2);
    });

    it("prefixo com flag (sudo -u, env -i) não esconde o push: nega", () => {
      expect(rodar(root, "sudo -u root git push --force origin feat/1-x", bench()).status).toBe(2);
      expect(rodar(root, "env -i PATH=/usr/bin git push origin HEAD:main", bench()).status).toBe(2);
    });

    it("valor colado ao flag (`nice -n10`, `env -uFOO`) não esconde o push: nega (#77)", () => {
      expect(rodar(root, "nice -n10 git push --force origin feat/1-x", bench()).status).toBe(2);
      expect(rodar(root, "env -uFOO git push origin HEAD:main", bench()).status).toBe(2);
      expect(rodar(root, "env -u FOO git push origin HEAD:main", bench()).status).toBe(2);
    });

    it("`--` depois de sudo/env e `nice -n N` não escondem o push: nega", () => {
      expect(rodar(root, "sudo -u root -- git push --force origin feat/1-x", bench()).status).toBe(
        2,
      );
      expect(rodar(root, "env -- git push origin HEAD:main", bench()).status).toBe(2);
      expect(rodar(root, "nice -n 10 git push --force origin feat/1-x", bench()).status).toBe(2);
    });

    it("git branch -D main: nega", () => {
      expect(rodar(root, "git branch -D main", bench()).status).toBe(2);
    });
  });

  describe("gh pr merge", () => {
    it("--admin: nega sem válvula", () => {
      const r = rodar(root, "gh pr merge 5 --admin", bench({ LOHRA_MERGE_LIVRE: "1" }));
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/admin/u);
    });

    it("--squash / --rebase: nega", () => {
      expect(rodar(root, "gh pr merge 5 --squash", bench()).status).toBe(2);
      expect(rodar(root, "gh pr merge 5 --rebase", bench()).status).toBe(2);
    });

    it("checks verdes + review:approved: permite", () => {
      expect(rodar(root, "gh pr merge 5 --merge", bench()).status).toBe(0);
    });

    it("um check vermelho: nega citando o check", () => {
      const r = rodar(
        root,
        "gh pr merge 5 --merge",
        bench({ LOHRA_PM_CHECKS_JSON: CHECKS_VERMELHOS }),
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/checks \(20\)=FAILURE/u);
    });

    it("sem label e com src/ no diff: nega", () => {
      const r = rodar(
        root,
        "gh pr merge 5 --merge",
        bench({ LOHRA_PM_VIEW_JSON: view([], ["src/x.ts", "README.md"]) }),
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/review:approved/u);
    });

    it("classe docs (só docs/**, README, CLAUDE.md, AGENTS.md) sem label: permite e avisa", () => {
      const r = rodar(
        root,
        "gh pr merge 5 --merge",
        bench({
          LOHRA_PM_VIEW_JSON: view(
            [],
            ["docs/adr/0005-x.md", "README.md", "CLAUDE.md", "AGENTS.md"],
          ),
        }),
      );
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/classe docs/u);
    });

    it("classe docs com check vermelho: nega (o waiver dispensa só a label)", () => {
      const r = rodar(
        root,
        "gh pr merge 5 --merge",
        bench({
          LOHRA_PM_VIEW_JSON: view([], ["docs/x.md"]),
          LOHRA_PM_CHECKS_JSON: CHECKS_VERMELHOS,
        }),
      );
      expect(r.status).toBe(2);
    });

    it("lista de arquivos truncada pelo gh (changedFiles > files): não é classe docs, nega", () => {
      const cem = Array.from({ length: 100 }, (_, i) => `docs/a${String(i).padStart(3, "0")}.md`);
      const r = rodar(
        root,
        "gh pr merge 5 --merge",
        bench({ LOHRA_PM_VIEW_JSON: view([], cem, 101) }),
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/truncad/u);
    });

    it("PR sem arquivos: não é classe docs, nega sem label", () => {
      expect(
        rodar(root, "gh pr merge 5 --merge", bench({ LOHRA_PM_VIEW_JSON: view([], []) })).status,
      ).toBe(2);
    });

    it("LOHRA_MERGE_LIVRE=1 pula checks e label (nunca --admin/--squash)", () => {
      expect(
        rodar(
          root,
          "gh pr merge 5 --merge",
          bench({ LOHRA_PM_CHECKS_JSON: CHECKS_VERMELHOS, LOHRA_MERGE_LIVRE: "1" }),
        ).status,
      ).toBe(0);
    });

    it("--repo é repassado ao gh (LOHRA_PM_ARGS_OUT registra os argumentos sob LOHRA_BENCH)", () => {
      const saida = path.join(root, "args.txt");
      const r = rodar(
        root,
        "gh pr merge 5 --repo o/r --merge",
        bench({ LOHRA_PM_ARGS_OUT: saida }),
      );
      expect(r.status).toBe(0);
      const linhas = readFileSync(saida, "utf8").trim().split("\n");
      expect(linhas).toEqual([
        "gh pr checks 5 --repo o/r --json name,state",
        "gh pr view 5 --repo o/r --json labels,reviewDecision,files,changedFiles",
      ]);
    });

    it("LOHRA_PM_ARGS_OUT sem LOHRA_BENCH não é lido: nada é gravado", () => {
      const saida = path.join(root, "args-sem-bench.txt");
      rodar(root, "gh pr merge 5 --repo o/r --merge", { LOHRA_PM_ARGS_OUT: saida });
      expect(existsSync(saida)).toBe(false);
    });
  });

  it("sem LOHRA_BENCH, nenhuma seam é lida: fora de um repo, o gh real falha e o hook nega", () => {
    const r = rodar(root, "gh pr merge 5 --merge", {
      LOHRA_PM_CHECKS_JSON: CHECKS_VERDES,
      LOHRA_PM_VIEW_JSON: view(["review:approved"], ["src/x.ts"]),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/não consegui ler|nenhum check/u);
  });

  it("comando sem push/merge/branch: sai 0 sem consultar nada", () => {
    expect(rodar(root, "ls -la", {}).status).toBe(0);
  });
});
