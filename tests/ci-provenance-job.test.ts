// Job `provenance` de `.github/workflows/ci.yml` (issue #160): push em `main`
// é estrito e `pull_request` tolera `pending` com SHA real via `--pending-ok`;
// o resultado `--json` vai para o step summary; `fetch-depth: 0` continua
// obrigatório (o script faz `git merge-base`). Leitura textual do bloco do job,
// no mesmo espírito de `tests/ci-workflow-order.test.ts`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CI = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

function blocoDoJob(yaml: string, job: string): string {
  const linhas = yaml.split(/\r?\n/);
  const inicio = linhas.findIndex((l) => l === `  ${job}:`);
  if (inicio === -1) throw new Error(`job ${job} ausente em ci.yml`);
  const corpo: string[] = [];
  for (const linha of linhas.slice(inicio + 1)) {
    if (/^ {2}\S/.test(linha)) break;
    corpo.push(linha);
  }
  return corpo.join("\n");
}

describe("ci.yml — job provenance (#160)", () => {
  const bloco = blocoDoJob(readFileSync(CI, "utf8"), "provenance");

  it("mantém fetch-depth: 0 (git merge-base precisa do histórico)", () => {
    expect(bloco).toMatch(/fetch-depth:\s*0/);
  });

  it("passa --pending-ok só em pull_request", () => {
    expect(bloco).toMatch(/github\.event_name == 'pull_request' && '--pending-ok'/);
  });

  it("emite --json e grava o resultado no step summary", () => {
    expect(bloco).toContain("--json");
    expect(bloco).toContain("GITHUB_STEP_SUMMARY");
  });

  it("não engole o exit code do verificador ao escrever o summary", () => {
    expect(bloco).toMatch(/exit \$status|exit "\$status"/);
  });
});
