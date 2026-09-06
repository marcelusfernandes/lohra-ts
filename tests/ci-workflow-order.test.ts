// Ordem dos steps do job `checks` em `.github/workflows/ci.yml` (issue #6 AC 4, sub-issue #108):
// `test` roda ANTES de `build`, provando a cada run que a suíte não depende de
// `dist/` (#2); `build` precede `typecheck` e `lint`, que precisam de `dist/`
// (scripts de paridade no `include` do tsconfig). Parser mínimo: linhas
// `- name: <x>` dentro do job `checks`, na ordem em que aparecem.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CI = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

function stepsDoJob(yaml: string, job: string): readonly string[] {
  const linhas = yaml.split(/\r?\n/);
  const inicio = linhas.findIndex((l) => l === `  ${job}:`);
  if (inicio === -1) throw new Error(`job ${job} ausente em ci.yml`);
  const nomes: string[] = [];
  for (const linha of linhas.slice(inicio + 1)) {
    if (/^ {2}\S/.test(linha)) break; // próximo job
    const m = /^\s+- name: (\S+)/.exec(linha);
    if (m?.[1] !== undefined) nomes.push(m[1]);
  }
  return nomes;
}

describe("ci.yml — ordem dos steps do job checks", () => {
  const steps = stepsDoJob(readFileSync(CI, "utf8"), "checks");
  const pos = (nome: string): number => {
    const i = steps.indexOf(nome);
    if (i === -1) throw new Error(`step ${nome} ausente: ${steps.join(", ")}`);
    return i;
  };

  it("test roda antes de build", () => {
    expect(pos("test")).toBeLessThan(pos("build"));
  });

  it("build precede typecheck e lint (ambos exigem dist/)", () => {
    expect(pos("build")).toBeLessThan(pos("typecheck"));
    expect(pos("build")).toBeLessThan(pos("lint"));
  });

  it("os cinco gates estão presentes uma vez cada", () => {
    for (const g of ["install", "build", "typecheck", "lint", "format:check", "test"]) {
      expect(steps.filter((s) => s === g)).toHaveLength(1);
    }
  });
});
