// Bancada dos scripts das skills de processo (`.claude/skills/**/scripts`),
// issue #79 (e #99: fences ignorados, bit de execução): `secao.sh` (extração de seção usada por `open-pr.sh`) e a
// validação de seções de `create-issue.sh --dry-run`. Nenhum dos dois toca a
// rede nesses caminhos; `create-issue.sh --dry-run` só imprime o comando.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECAO = fileURLToPath(new URL("../.claude/skills/pr/scripts/secao.sh", import.meta.url));
const CREATE = fileURLToPath(
  new URL("../.claude/skills/issue/scripts/create-issue.sh", import.meta.url),
);

function secao(
  nome: string,
  corpo: string,
): { readonly status: number | null; readonly out: string } {
  const r = spawnSync("sh", [SECAO, nome], { input: corpo, encoding: "utf8" });
  return { status: r.status, out: r.stdout };
}

const CORPO = [
  "> **Tamanho:** S — x",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] a",
  "",
  "- [ ] b",
  "",
  "## Proof",
  "",
  "- Comando: `npm run prova -- x`",
  "",
  "### Detalhe",
  "",
  "- sub",
  "",
  "## Files",
  "",
  "- `src/a.ts`",
  "- `tests/a.test.ts`",
  "",
].join("\n");

describe("secao.sh", () => {
  it("seção no meio do corpo: conteúdo sem o heading e sem linhas em branco", () => {
    const r = secao("Acceptance Criteria", CORPO);
    expect(r.status).toBe(0);
    expect(r.out).toBe("- [ ] a\n- [ ] b\n");
  });

  it("seção com `###` internos: os subtítulos ficam (corta só em heading de nível igual ou superior)", () => {
    expect(secao("Proof", CORPO).out).toBe("- Comando: `npm run prova -- x`\n### Detalhe\n- sub\n");
  });

  it("última seção do corpo: vai até o fim, sem perder a última linha", () => {
    expect(secao("Files", CORPO).out).toBe("- `src/a.ts`\n- `tests/a.test.ts`\n");
  });

  it("seção ausente: saída vazia, exit 0", () => {
    const r = secao("Referências", CORPO);
    expect(r.status).toBe(0);
    expect(r.out).toBe("");
  });

  it("heading `###` (formulário issue.yml) é aceito quando não há `##` com o nome", () => {
    const corpo = "### Files\n\n- `x`\n\n### Fora de escopo\n\n- y\n";
    expect(secao("Files", corpo).out).toBe("- `x`\n");
  });

  it("um `#` de nível superior encerra a seção", () => {
    const corpo = "## Files\n\n- `x`\n\n# Outro\n\n- y\n";
    expect(secao("Files", corpo).out).toBe("- `x`\n");
  });

  it("heading dentro de bloco de código (fence) é ignorado — mesma regra do check `escopo`", () => {
    const corpo = [
      "## Proof",
      "",
      "- Comando: `npm run prova -- x`",
      "",
      "```",
      "## Files",
      "- falso",
      "```",
      "",
      "## Files",
      "",
      "- `x`",
      "",
    ].join("\n");
    expect(secao("Files", corpo).out).toBe("- `x`\n");
  });

  it("secao.sh tem bit de execução (modo 100755, como open-pr.sh)", () => {
    expect(statSync(SECAO).mode & 0o111).not.toBe(0);
  });
});

const SECOES = [
  "User Story",
  "Contexto",
  "Cenário atual",
  "Problema",
  "Consequências do problema",
  "O que é a solução",
  "Resultado esperado com a solução",
  "Acceptance Criteria",
  "Proof",
  "Files",
  "Fora de escopo",
  "Referências",
];

function corpoValido(nivel: "##" | "###" = "##"): string {
  return (
    "> **Tamanho:** S — x\n> **Parent / Sub-issues:** nenhuma\n\n" +
    SECOES.map((s) => `${nivel} ${s}\n\n- ${s === "Acceptance Criteria" ? "[ ] " : ""}x\n`).join(
      "\n",
    )
  );
}

describe("create-issue.sh --dry-run", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "create-issue-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function criar(corpo: string): {
    readonly status: number | null;
    readonly out: string;
    readonly err: string;
  } {
    const arquivo = path.join(dir, `corpo-${String(Math.random()).slice(2)}.md`);
    writeFileSync(arquivo, corpo);
    const r = spawnSync(
      "sh",
      [CREATE, "--title", "chore: x", "--body-file", arquivo, "--milestone", "M", "--dry-run"],
      { encoding: "utf8" },
    );
    return { status: r.status, out: r.stdout, err: r.stderr };
  }

  it("corpo válido com `##`: aceito, complexity derivada do header, sem criar nada", () => {
    const r = criar(corpoValido("##"));
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/dry-run: gh issue create .*--label complexity:S/u);
  });

  it("corpo válido com `###` (formulário issue.yml): aceito", () => {
    expect(criar(corpoValido("###")).status).toBe(0);
  });

  it("seção ausente: recusado com exit 2 citando a seção", () => {
    const r = criar(corpoValido().replace("## Proof\n\n- x\n", ""));
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/seção ausente.*Proof/u);
  });

  it("seção fora de ordem: recusado com exit 2 citando a ordem", () => {
    const corpo = corpoValido()
      .replace("## Proof\n\n- x\n", "## Files\n\n- x\n")
      .replace("## Files\n\n- x\n\n## Fora de escopo", "## Proof\n\n- x\n\n## Fora de escopo");
    const r = criar(corpo);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/fora de ordem/u);
  });
});
