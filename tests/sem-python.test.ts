import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Issue #165: `npm test` não pode depender de `python3` no PATH. Os quatro
// testes de paridade que ainda spawnavam um interpretador Python real
// (bounds, harness, process, socket-sentinel) perdem o lado Python — o lado
// TypeScript continua provando o mesmo contrato (limites, sentinela,
// preservação de exitCode/stdout/stderr). Este arquivo é o meta-teste
// permanente: prende que nenhum arquivo em `tests/` volta a spawnar
// `python3`/`runPythonProcess`.
//
// Acréscimo do veredito da PR #184 (comentário de reconciliação em #165): a
// varredura de Python em `tests/t22-docs.test.ts` só pega o literal inline
// como 1º argumento de `spawn` — escapam `py`, `/usr/bin/python3`, uma
// chamada quebrada em várias linhas, ou o executável vindo de uma variável.
// Este meta-teste soma dois greps diretos aos que já existiam:
//   1. um grep literal de `"python3"` em `src/**` e `tests/**` — hoje vazio
//      em `src/`; em `tests/` só as menções já classificadas como
//      "asserções de ausência" no contexto da issue (`t22-docs`,
//      `json-numbers`, `doctor-checks-remedy`, `doutor`) podem restar;
//   2. uma varredura de todo o texto do arquivo (não linha a linha, para
//      pegar chamadas quebradas em várias linhas) por qualquer forma
//      conhecida de amarrar um teste a um interpretador Python real:
//      `runPythonProcess`, `pythonExecutable`, a variável de ambiente
//      `PYTHON`, e uma chamada de spawn/exec cujo argumento (literal ou logo
//      em seguida) menciona `python`.
//
// `adapter: "python"` sozinho fica fora da varredura: `manifest.test.ts` usa
// o valor só para provar o *schema* do manifesto (`parseScenarioManifest`),
// nunca chama `runScenario` — não spawna nada. O que de fato aciona o lado
// Python do harness (`scripts/parity/harness.ts:194-197`) é passar
// `pythonExecutable` (ou deixar `runScenario` resolver um workspace Python),
// e isso os padrões abaixo cobrem.
//
// Limite reconhecido: uma variável cujo *nome* não menciona Python mas cujo
// *valor* é um caminho para um interpretador Python escaparia de uma
// varredura textual. Os padrões abaixo cobrem toda forma hoje existente no
// repositório (nenhuma delas usa esse indireto).

const root = resolve(import.meta.dirname, "..");
const SELF = relative(root, resolve(import.meta.dirname, "sem-python.test.ts"));

function listTsFiles(dir: string): string[] {
  const base = resolve(root, dir);
  return readdirSync(base, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
    .map((entry) => resolve(base, entry));
}

function relativePath(file: string): string {
  return relative(root, file).split("\\").join("/");
}

// Menções já existentes de "python3" que a issue classifica como asserção de
// ausência (checam que uma mensagem NÃO cita python3, ou documentam em
// comentário/título de teste por que a palavra aparece) — nenhuma delas
// spawna nada.
const ALLOWED_PYTHON3_LITERAL_FILES = [
  "tests/t22-docs.test.ts",
  "tests/json-numbers.test.ts",
  "tests/doctor-checks-remedy.test.ts",
  "tests/doutor.test.ts",
].sort();

const SPAWN_LIKE_PYTHON_RE =
  /\b(?:spawn|spawnSync|exec|execFile|execSync|execFileSync)\s*\([^)]*python/iu;

describe("suíte sem python3", () => {
  it("nenhum arquivo em src/ menciona o literal python3", () => {
    const hits = listTsFiles("src").flatMap((file) => {
      const path = relativePath(file);
      return readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes("python3"))
        .map(({ line, index }) => `${path}:${String(index + 1)}: ${line.trim()}`);
    });
    expect(hits).toEqual([]);
  });

  it("só arquivos já classificados como asserção de ausência mencionam python3 em tests/", () => {
    const filesWithHits = new Set<string>();
    for (const file of listTsFiles("tests")) {
      const path = relativePath(file);
      if (path === SELF) continue;
      if (readFileSync(file, "utf8").includes("python3")) {
        filesWithHits.add(path);
      }
    }
    expect([...filesWithHits].sort()).toEqual(ALLOWED_PYTHON3_LITERAL_FILES);
  });

  it("nenhum arquivo em tests/ spawna python3 ou usa o adapter Python do harness", () => {
    const identifierHits = listTsFiles("tests").flatMap((file) => {
      const path = relativePath(file);
      if (path === SELF) return [];
      const content = readFileSync(file, "utf8");
      const findings: string[] = [];
      if (content.includes("runPythonProcess")) findings.push("runPythonProcess");
      if (content.includes("pythonExecutable")) findings.push("pythonExecutable");
      if (/\bPYTHON\b/u.test(content)) findings.push("PYTHON (env var)");
      if (SPAWN_LIKE_PYTHON_RE.test(content)) findings.push("spawn/exec com python no argv");
      return findings.map((reason) => `${path}: ${reason}`);
    });
    expect(identifierHits).toEqual([]);
  });
});
