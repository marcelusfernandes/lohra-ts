// Issue #209: `guarda-main.yml` (camada 4) abriu a issue #207 para o merge
// commit legítimo da PR #206 — a associação commit→PR do GitHub é indexada
// de forma assíncrona, e uma única consulta imediata ao push devolveu 0.
// Este teste prende a forma do step por leitura textual do YAML (mesmo
// idioma de ci-mutations-workflow.test.ts): retry com espera antes de
// concluir "sem PR", confirmação direta pelo merge commit (`Merge pull
// request #N` + `gh pr view N` com `mergeCommit.oid == sha`), exceção
// `[permite-push-main]` preservada, e tentativas registradas no corpo da
// issue aberta.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOW = fileURLToPath(new URL("../.github/workflows/guarda-main.yml", import.meta.url));
const README = fileURLToPath(new URL("../.claude/hooks/README.md", import.meta.url));

function stepSemComentarios(yaml: string): string {
  const inicio = yaml.indexOf("run: |");
  if (inicio === -1) throw new Error("guarda-main.yml sem bloco `run: |`");
  return yaml
    .slice(inicio)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("guarda-main.yml — retry antes de acusar push direto (#209)", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");
  const step = stepSemComentarios(yaml);

  it("consulta commits/<sha>/pulls até três vezes, com espera entre tentativas", () => {
    expect(step).toContain('gh api "repos/$REPO/commits/$SHA/pulls"');
    expect(step).toMatch(/for tentativa in 1 2 3/);
    expect(step).toMatch(/sleep/);
  });

  it("aceita merge commit confirmado pela própria PR (mergeCommit.oid == sha), sem depender do índice", () => {
    expect(step).toMatch(/Merge pull request #/);
    expect(step).toContain("gh pr view");
    expect(step).toContain("mergeCommit.oid");
  });

  it("mantém a exceção declarada [permite-push-main] antes de qualquer consulta", () => {
    const excecao = step.indexOf("[permite-push-main]");
    const consulta = step.indexOf("commits/$SHA/pulls");
    expect(excecao).toBeGreaterThan(-1);
    expect(consulta).toBeGreaterThan(excecao);
  });

  it("só abre a issue human depois das tentativas, registrando-as no corpo", () => {
    const loop = step.indexOf("for tentativa in 1 2 3");
    const cria = step.indexOf("gh issue create");
    expect(loop).toBeGreaterThan(-1);
    expect(cria).toBeGreaterThan(loop);
    expect(step).toContain("--label human");
    expect(step).toMatch(/tentativas/);
  });

  it("continua falhando o job quando nenhuma tentativa achou PR", () => {
    expect(step).toMatch(/::error::/);
    expect(step).toMatch(/exit 1\s*$/m);
  });

  it("README dos hooks (camada 4) cita o retry", () => {
    const readme = readFileSync(README, "utf8");
    const linha = readme.split("\n").find((l) => l.includes("guarda-main.yml"));
    expect(linha, "linha da camada 4 ausente no README").toBeDefined();
    expect(linha).toMatch(/retry|tentativas/);
  });
});
