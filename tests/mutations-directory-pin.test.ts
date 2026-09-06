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
// recursivamente (inclusive `fixtures/`). Uma única exceção é permitida, e
// só por um motivo mecânico — nunca por prosa: `fixtures/t15-chat-workflow
// .json`, campo `oracleGuard.expectedCommit`. Esse valor é consumido de
// verdade por `scripts/parity/guard.ts`/`manifest.ts` para checar que o
// checkout do oráculo Python está no commit esperado antes de rodar o
// cenário bilateral do fixture — é dado funcional, não comentário citando
// origem. Apagá-lo ou reescrevê-lo mudaria o comportamento do runner, que
// esta issue declara fora de escopo ("Fora de escopo: comportamento dos
// runners"). O allowlist abaixo é uma entrada exata (arquivo, padrão), não
// uma exclusão de extensão: um `.json` novo sob `scripts/mutations/` que
// citar qualquer um dos literais fora dessa entrada continua reprovando
// aqui.
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

/** Única exceção documentada: dado funcional consumido pelo guard do
 * oráculo, não prosa citando origem — ver o comentário do arquivo acima. */
const ALLOWLIST: ReadonlySet<string> = new Set([
  "scripts/mutations/fixtures/t15-chat-workflow.json::oracle-sha",
]);

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
