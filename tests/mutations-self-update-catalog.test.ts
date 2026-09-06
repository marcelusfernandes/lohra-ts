// Teste-pino do catálogo de mutantes de `src/` que sobrevivem à triagem de
// `scripts/parity/closeout/run-closeout-mutations.ts` (issue #153, passo 0f
// do épico #13): trava as 8 entradas migradas (`self-update/service.ts` x3,
// `self-update/repo.ts`, `tools/terminal.ts`, `mcp/manager.ts`,
// `gateway/session-service.ts`, `commands/session-tools.ts`), o foco por
// `{file, test}` (não por título solto — renomear um teste sem atualizar o
// catálogo tem que quebrar aqui) e a ausência de literais herdados do
// diretório histórico de paridade.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { mutants } from "../scripts/mutations/self-update-mutants.js";

const repoRoot = resolve(import.meta.dirname, "..");

function realTestTitles(testSource: string): ReadonlySet<string> {
  const titles = new Set<string>();
  const pattern = /\b(?:it|test)\(\s*["'`]([^"'`]+)["'`]/g;
  let match;
  while ((match = pattern.exec(testSource)) !== null) {
    const title = match[1];
    if (title !== undefined) titles.add(title);
  }
  return titles;
}

describe("catálogo de mutação self-update", () => {
  it("tem exatamente 8 mutantes", () => {
    expect(mutants).toHaveLength(8);
  });

  it("ids são únicos", () => {
    const ids = mutants.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cada foco aponta para um arquivo de teste que existe", () => {
    for (const mutant of mutants) {
      const focusPath = resolve(repoRoot, mutant.focus.file);
      expect(existsSync(focusPath), `${mutant.id}: ${mutant.focus.file} não existe`).toBe(true);
    }
  });

  it("cada foco casa com um título de teste real (não string solta em comentário)", () => {
    const sourceByFile = new Map<string, ReadonlySet<string>>();
    for (const mutant of mutants) {
      let titles = sourceByFile.get(mutant.focus.file);
      if (titles === undefined) {
        const source = readFileSync(resolve(repoRoot, mutant.focus.file), "utf8");
        titles = realTestTitles(source);
        sourceByFile.set(mutant.focus.file, titles);
      }
      expect(
        titles.has(mutant.focus.test),
        `${mutant.id}: "${mutant.focus.test}" não é um título real em ${mutant.focus.file}`,
      ).toBe(true);
    }
  });

  it("cada edit aponta para um arquivo de código-fonte existente", () => {
    for (const mutant of mutants) {
      for (const edit of mutant.edits) {
        const path = resolve(repoRoot, edit.file);
        expect(existsSync(path), `${mutant.id}: ${edit.file} não existe`).toBe(true);
      }
    }
  });

  it("cada edit é uma âncora única no arquivo alvo em HEAD", () => {
    const sourceByFile = new Map<string, string>();
    for (const mutant of mutants) {
      for (const edit of mutant.edits) {
        let source = sourceByFile.get(edit.file);
        if (source === undefined) {
          source = readFileSync(resolve(repoRoot, edit.file), "utf8");
          sourceByFile.set(edit.file, source);
        }
        const count = source.split(edit.before).length - 1;
        expect(count, `${mutant.id}: âncora em ${edit.file} ocorre ${String(count)} vezes`).toBe(1);
      }
    }
  });

  // As duas checagens abaixo cobrem os dois arquivos do runner (catálogo +
  // orquestração): nenhum deve herdar shebang, binário absoluto ou caminho
  // do diretório histórico de paridade (achado da rodada 1 da PR #170,
  // repetido aqui porque outra sub-issue do épico #13 cuida só dos runners
  // já migrados).
  const runnerFiles = [
    "scripts/mutations/self-update-mutants.ts",
    "scripts/mutations/self-update.ts",
  ] as const;

  it("nenhum arquivo do runner referencia binários absolutos ou scripts/parity", () => {
    for (const file of runnerFiles) {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      expect(source, file).not.toMatch(/\/usr\/bin\//);
      expect(source, file).not.toMatch(/scripts\/parity/);
    }
  });
});
