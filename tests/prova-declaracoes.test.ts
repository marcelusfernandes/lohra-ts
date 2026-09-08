// Pino: toda `prova/<slug>.ts` só declara arquivos de teste que existem,
// moram sob `tests/` e terminam em `.test.ts`; o nome do arquivo (slug) casa
// `^[a-z0-9-]+$`. Descoberto na revisão da PR #212 (#167): `scripts/prova/
// run.ts` só falha fechado (`prova: arquivo declarado não existe`) quando
// aquele slug específico roda — nenhum check varria as outras declarações,
// então apagar um teste referenciado por uma prova antiga passava em
// silêncio (CLAUDE.md, invariante 2).
import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { validarDeclaracao } from "../scripts/prova/run.js";

const ROOT = resolve(__dirname, "..");
// Mesmo padrão de `scripts/prova/run.ts:33` (`SLUG_RE`, não exportado —
// "Fora de escopo" da issue #214 proíbe editar `scripts/prova/**`).
const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Importa a declaração em `caminhoRelativo` (relativo à raiz do repo),
 * valida a forma com `validarDeclaracao` — o mesmo parser de
 * `scripts/prova/run.ts` — e assevera que todo caminho em `unit`:
 *  - existe;
 *  - mora sob `tests/`;
 *  - termina em `.test.ts`.
 * Lança um erro citando o slug (nome do arquivo, sem `.ts`) e o caminho
 * problemático.
 */
export async function verificarDeclaracao(caminhoRelativo: string): Promise<void> {
  const slug = basename(caminhoRelativo, ".ts");
  const caminhoAbsoluto = resolve(ROOT, caminhoRelativo);
  const modulo: unknown = await import(pathToFileURL(caminhoAbsoluto).href);
  const default_ = (modulo as { default?: unknown }).default;
  const declaracao = validarDeclaracao(default_, caminhoRelativo);

  for (const caminhoUnit of declaracao.unit) {
    if (!existsSync(resolve(ROOT, caminhoUnit))) {
      throw new Error(
        `prova-declaracoes: slug "${slug}" declara um arquivo de teste que não existe: ${caminhoUnit}`,
      );
    }
    if (!caminhoUnit.startsWith("tests/") || !caminhoUnit.endsWith(".test.ts")) {
      throw new Error(
        `prova-declaracoes: slug "${slug}" declara "${caminhoUnit}", que precisa estar sob tests/ e terminar em .test.ts`,
      );
    }
  }
}

describe("prova-declaracoes", () => {
  const provaDir = resolve(ROOT, "prova");
  const arquivos = readdirSync(provaDir)
    .filter((nome) => nome.endsWith(".ts"))
    .sort();

  it("encontra pelo menos uma declaração em prova/", () => {
    expect(arquivos.length).toBeGreaterThan(0);
  });

  it.each(arquivos)('o slug de "%s" casa /^[a-z0-9-]+$/', (nome) => {
    const slug = basename(nome, ".ts");
    expect(slug).toMatch(SLUG_RE);
  });

  it.each(arquivos)("prova/%s só declara arquivos de teste existentes sob tests/", async (nome) => {
    await expect(verificarDeclaracao(`prova/${nome}`)).resolves.toBeUndefined();
  });

  it("reprova uma declaração cujo unit aponta para um caminho inexistente, citando slug e caminho", async () => {
    const caminhoFixture = "tests/fixtures/prova-declaracoes/quebrada.ts";
    await expect(verificarDeclaracao(caminhoFixture)).rejects.toThrow(
      /quebrada[\s\S]*tests\/fixtures\/prova-declaracoes\/caminho-inexistente\.test\.ts/,
    );
  });

  it("reprova uma declaração cujo unit existe mas não está sob tests/ ou não termina em .test.ts", async () => {
    const caminhoFixture = "tests/fixtures/prova-declaracoes/fora-de-tests.ts";
    await expect(verificarDeclaracao(caminhoFixture)).rejects.toThrow(
      /fora-de-tests[\s\S]*precisa estar sob tests\/ e terminar em \.test\.ts/,
    );
  });
});
