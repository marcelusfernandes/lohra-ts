// Funções puras do controle negativo (issue #48): nenhuma lê disco nem
// invoca git/npm — quem faz I/O é `run.ts`. Testável por fixtures diretas.
import type { Falha, Resumo } from "../../prova/tipos.js";

/** Os quatro desfechos possíveis de rodar a prova da PR contra a base. */
export type Desfecho = "assertion-red" | "structural-red" | "empty-red" | "vacuous-pass";

/**
 * Filtra o diff da PR para os arquivos que compõem o "overlay" aplicado
 * sobre a base: os testes em `tests/**\/*.test.ts` e tudo sob `prova/**`
 * (a própria declaração `prova/<slug>.ts`, que também precisa ir para a
 * base — sem ela `npm run prova -- <slug>` não sabe o que rodar lá).
 */
export function arquivosDeTeste(_diff: readonly string[]): readonly string[] {
  throw new Error("not implemented: arquivosDeTeste");
}

// `nome` que `scripts/prova/resumo.ts` e `scripts/prova/run.ts` escrevem
// quando a falha não é uma asserção real, mas a incapacidade de rodar o
// teste declarado:
//   - "<arquivo> did not run"   (resumo.ts: arquivo declarado ausente do
//     relatório do vitest)
//   - "<arquivo> ran zero tests" (resumo.ts: coletou, mas só skip/todo)
//   - "npm run typecheck"       (run.ts, quando `check: true` reprova)
//   - "vitest run"              (run.ts, processo do vitest falhou sem
//     deixar `resumo.ok` refletir isso sozinho)
// e o próprio caminho do arquivo (terminando em `.test.ts`) quando
// `colecionou: false` (resumo.ts: `falhas.push({ nome: arquivo.arquivo, ... })`
// para um arquivo que nem foi coletado — import quebrado, erro de sintaxe).
// Qualquer outro `nome` é o `fullName` de um teste do vitest que rodou e
// reprovou de verdade — uma asserção.
function ehFalhaEstrutural(_falha: Falha): boolean {
  throw new Error("not implemented: ehFalhaEstrutural");
}

/**
 * Classifica o `resumo.json` da prova rodada na base. Só `vacuous-pass`
 * deve reprovar o check — os outros três já são "vermelho o bastante" para
 * provar que o teste não passa sem a implementação.
 */
export function classificar(_resumo: Resumo): Desfecho {
  void ehFalhaEstrutural;
  throw new Error("not implemented: classificar");
}

/**
 * `true` quando o `package.json` da base não declara `scripts.prova` — o
 * harness (#42) ainda não existia naquele commit. Não é uma falha do
 * controle negativo: não há como rodar a prova ali, então conta como PASS
 * logado, não `vacuous-pass`.
 */
export function semHarnessNaBase(_packageJsonText: string): boolean {
  throw new Error("not implemented: semHarnessNaBase");
}

/**
 * `structural-red` só é aceito como controle negativo válido se o último
 * commit da PR que tocou os arquivos de teste for `test(red):` — a
 * convenção de `worktree-segura` §7 (stub que lança para o vermelho
 * compilar). Sem isso, uma falha estrutural é indistinguível de um overlay
 * quebrado por acidente (arquivo de produção que a base não tem).
 */
export function ehCommitTestRed(_subject: string): boolean {
  throw new Error("not implemented: ehCommitTestRed");
}

/** Argumentos de `npm run ci:controle-negativo -- --base <sha> --head <sha> [--slug <s>] [--root <dir>]`. */
export interface Args {
  readonly base?: string;
  readonly head?: string;
  readonly slug?: string;
  readonly root?: string;
}

/** Parser posicional simples — sem dependência nova (AC da issue #48). */
export function parseArgs(_argv: readonly string[]): Args {
  throw new Error("not implemented: parseArgs");
}
