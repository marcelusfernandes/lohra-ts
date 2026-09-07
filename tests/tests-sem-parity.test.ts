// Issue #166 (épico #8): `tests/` não pode mais importar/citar o diretório
// histórico de paridade (ver NEEDLE abaixo) — #167 apaga esse diretório.
// AC1: só os testes de classe A (o próprio harness de paridade, sujeito =
// um módulo que fica lá até #167) podem seguir citando o caminho; todo o
// resto tem que estar limpo, inclusive helpers não-`.test.ts`
// (`tests/helpers/**`) e o conteúdo migrado para `tests/support/**` e
// `tests/fixtures/**`.
//
// A whitelist abaixo é a classe A inteira, hoje: cada um desses arquivos
// continua importando, do diretório histórico, um módulo que NÃO se move
// nesta issue (o sujeito do teste é o próprio harness), e será apagado
// junto com ele em #167. Tabela módulo -> teste no corpo da PR #166.
//
// `tests/mutations-harness.test.ts` PRECISA checar, em runtime, que outros
// arquivos não citam o caminho — mas constrói o literal via `join("/")`
// (mesmo motivo do NEEDLE abaixo: ficar fora do grep) em vez de entrar
// nesta whitelist, porque seu sujeito não é o harness de paridade.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

const testsRoot = resolve(import.meta.dirname);

// Construído para não conter o literal contíguo -- senão este próprio
// arquivo apareceria no grep que ele mesmo prova estar vazio.
const NEEDLE = ["scripts", "parity"].join("/");

const CLASSE_A_ALLOWLIST: readonly string[] = [
  "tests/parity/bounds.test.ts",
  "tests/parity/capture.test.ts",
  "tests/parity/cli.test.ts",
  "tests/parity/guard.test.ts",
  "tests/parity/harness.test.ts",
  "tests/parity/preconditions.test.ts",
  "tests/parity/process.test.ts",
  "tests/parity/scrub.test.ts",
  "tests/parity/t22-harness-pins.test.ts",
];

function listAllFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listAllFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function toRepoRelative(file: string): string {
  return relative(resolve(testsRoot, ".."), file).split(sep).join("/");
}

describe(`tests/ sem citações a ${NEEDLE} fora da classe A`, () => {
  const files = listAllFiles(testsRoot).map(toRepoRelative);

  it("a varredura acha os arquivos conhecidos (regressão do glob)", () => {
    // Hoje há mais de 150 arquivos sob tests/ (inclusive helpers/, fixtures/
    // e o que esta issue migra para support/); um número muito menor indica
    // que o glob parou de descer em algum subdiretório.
    expect(files.length).toBeGreaterThan(150);
  });

  it("nenhum arquivo fora da classe A cita scripts/parity", () => {
    const offenders = files
      .filter((relPath) => !CLASSE_A_ALLOWLIST.includes(relPath))
      .filter((relPath) => readFileSync(resolve(testsRoot, "..", relPath), "utf8").includes(NEEDLE))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("a whitelist da classe A não tem entrada morta (todas existem e citam o caminho)", () => {
    for (const relPath of CLASSE_A_ALLOWLIST) {
      const full = resolve(testsRoot, "..", relPath);
      expect(files, relPath).toContain(relPath);
      expect(readFileSync(full, "utf8"), relPath).toContain(NEEDLE);
    }
  });

  it("a whitelist está ordenada e sem duplicatas", () => {
    expect(CLASSE_A_ALLOWLIST).toEqual([...CLASSE_A_ALLOWLIST].sort());
    expect(new Set(CLASSE_A_ALLOWLIST).size).toBe(CLASSE_A_ALLOWLIST.length);
  });
});
