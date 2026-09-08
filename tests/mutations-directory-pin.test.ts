// Pino de diretório para os literais de paridade/oráculo em
// `scripts/mutations/**` (issue #178, follow-up da rodada 2 da PR #174).
//
// AC 1 dos passos 0c/0e do épico #13: `grep -rn
// "16b4785d\|/usr/bin/\|scripts/parity\|^#!" scripts/mutations/` tem que
// ficar vazio para o DIRETÓRIO INTEIRO, não só para os arquivos que cada PR
// de migração tocou. Cada PR (#149, #150, #151, #152) fechou o AC 1 só nos
// próprios arquivos; a rodada 2 do revisor na PR #174 contou 12 linhas
// residuais no diretório inteiro, vindas de PRs já mergeadas: o shebang
// herdado de `web-tools.ts` (arquivo modo 100644, invocado só por `tsx` —
// nunca executado como binário) e prosa citando `scripts/parity` em
// `web-tools.ts`/`web-tools-mutants.ts`. Este teste prende o diretório
// inteiro, não um runner por vez.
//
// Varre todo `.ts`/`.mts`/`.mjs`/`.json` sob `scripts/mutations/`
// recursivamente (inclusive `fixtures/`).
//
// Hoje não há nenhuma exceção: `fixtures/t15-chat-workflow.json` tinha um
// bloco `oracleGuard.expectedCommit` com o SHA do oráculo Python, mas essa
// CÓPIA nunca é lida por `scripts/parity/guard.ts`/`manifest.ts` — só o
// manifesto original em `scripts/parity/manifests/t15/t15-chat-workflow
// .json` passa por esse harness (`scripts/parity/workflow-executor/run-all
// .ts:102`). Os únicos leitores desta cópia são
// `scripts/mutations/workflow-executor-mutants.ts` (dois mutantes que
// editam só as chaves `normalizations`/`comparisons`; catálogo extraído do
// runner na issue #186 — antes era `workflow-executor.ts:514,531`) e
// `tests/mutations-fixtures-workflow-executor.test.ts` (mesmas duas
// chaves, via a interface `T15Policy`, que nem declara `oracleGuard`) —
// o bloco era morto na cópia. Apagado (rodada 2 da PR #182, veredito do
// revisor: a exceção original citava `guard.ts`/`manifest.ts` para uma
// cópia que nenhum dos dois lê).
//
// O `ALLOWLIST` abaixo continua existindo como mecanismo — uma entrada
// exata (arquivo, padrão), nunca uma exclusão de extensão — para o dia em
// que uma exceção de verdade precisar ser documentada; hoje está vazio, e
// o teste abaixo prova que continua vazio de propósito (nenhuma entrada
// morta).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const mutationsRoot = resolve(repoRoot, "scripts/mutations");

interface ForbiddenPattern {
  readonly id: string;
  readonly pattern: RegExp;
}

const FORBIDDEN: readonly ForbiddenPattern[] = [
  { id: "oracle-sha", pattern: /16b4785d/ },
  { id: "absolute-binary", pattern: /\/usr\/bin\// },
  { id: "parity-path", pattern: /scripts\/parity/ },
  { id: "shebang", pattern: /^#!/m },
];

/** Exceções documentadas (arquivo::padrão) a um literal proibido — nunca por
 * prosa, só por um motivo mecânico verificável. Vazio hoje; ver o
 * comentário do arquivo acima para o histórico da única exceção que já
 * existiu aqui (removida, não substituída). */
const ALLOWLIST: ReadonlySet<string> = new Set([]);

const SCANNED_EXTENSIONS = /\.(ts|mts|mjs|json)$/;

function listScannedFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listScannedFiles(full));
    } else if (SCANNED_EXTENSIONS.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function toRepoRelative(file: string): string {
  return relative(repoRoot, file).split(sep).join("/");
}

describe("pino de diretório: scripts/mutations/** sem literais de paridade/oráculo", () => {
  const files = listScannedFiles(mutationsRoot);

  it("a varredura acha os arquivos conhecidos (regressão do glob)", () => {
    // Hoje há mais de 15 arquivos `.ts`/`.mjs`/`.json` sob scripts/mutations/
    // (inclusive fixtures/); um número muito menor indica que o glob parou
    // de descer em algum subdiretório.
    expect(files.length).toBeGreaterThan(15);
  });

  it("nenhum arquivo cita o SHA do oráculo, /usr/bin/, scripts/parity ou tem shebang, fora do allowlist", () => {
    const violations: string[] = [];
    for (const file of files) {
      const relPath = toRepoRelative(file);
      const source = readFileSync(file, "utf8");
      for (const { id, pattern } of FORBIDDEN) {
        if (pattern.test(source) && !ALLOWLIST.has(`${relPath}::${id}`)) {
          violations.push(`${relPath}: ${id} (${pattern.source})`);
        }
      }
    }
    expect(violations, `literais proibidos encontrados:\n${violations.join("\n")}`).toEqual([]);
  });

  it("o allowlist não tem entrada morta (a exceção declarada ainda existe no arquivo)", () => {
    for (const key of ALLOWLIST) {
      const [relPath, id] = key.split("::") as [string, string];
      const forbidden = FORBIDDEN.find((entry) => entry.id === id);
      expect(forbidden, `id de padrão desconhecido no allowlist: ${id}`).toBeDefined();
      const source = readFileSync(resolve(repoRoot, relPath), "utf8");
      expect(forbidden?.pattern.test(source), `allowlist morto: ${key}`).toBe(true);
    }
  });
});
