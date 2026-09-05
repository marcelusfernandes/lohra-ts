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
const TESTE_RE = /^tests\/.+\.test\.ts$/;
const PROVA_RE = /^prova\//;

export function arquivosDeTeste(diff: readonly string[]): readonly string[] {
  return diff.filter((arquivo) => TESTE_RE.test(arquivo) || PROVA_RE.test(arquivo));
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
const NOME_ESTRUTURAL_RE = /^(npm run typecheck|vitest run|.+ did not run|.+ ran zero tests)$/;

function ehFalhaEstrutural(falha: Falha): boolean {
  if (NOME_ESTRUTURAL_RE.test(falha.nome)) return true;
  // Falha de coleta (`colecionou: false`): `resumo.ts` usa o próprio
  // caminho do arquivo de teste como `nome` — nunca o `fullName` de um
  // teste (que não termina em `.test.ts`).
  return falha.nome.endsWith(".test.ts");
}

/**
 * Classifica o `resumo.json` da prova rodada na base. Só `vacuous-pass`
 * deve reprovar o check — os outros três já são "vermelho o bastante" para
 * provar que o teste não passa sem a implementação.
 */
export function classificar(resumo: Resumo): Desfecho {
  if (resumo.ok) return "vacuous-pass";
  if (resumo.falhas.length === 0) return "empty-red";
  const naoEstruturais = resumo.falhas.filter((falha) => !ehFalhaEstrutural(falha));
  return naoEstruturais.length > 0 ? "assertion-red" : "structural-red";
}

/**
 * `true` quando o `package.json` da base não declara `scripts.prova` — o
 * harness (#42) ainda não existia naquele commit. Não é uma falha do
 * controle negativo: não há como rodar a prova ali, então conta como PASS
 * logado, não `vacuous-pass`.
 */
export function semHarnessNaBase(packageJsonText: string): boolean {
  try {
    const pkg = JSON.parse(packageJsonText) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.["prova"] !== "string";
  } catch {
    // JSON inválido, ou texto vazio (package.json nem existe na base) —
    // conta como "sem harness", não como erro.
    return true;
  }
}

/**
 * `structural-red` só é aceito como controle negativo válido se o último
 * commit da PR que tocou os arquivos de teste for `test(red):` — a
 * convenção de `worktree-segura` §7 (stub que lança para o vermelho
 * compilar). Sem isso, uma falha estrutural é indistinguível de um overlay
 * quebrado por acidente (arquivo de produção que a base não tem).
 */
const TEST_RED_RE = /^test\(red\):/;

export function ehCommitTestRed(subject: string): boolean {
  return TEST_RED_RE.test(subject.trim());
}

/** Argumentos de `npm run ci:controle-negativo -- --base <sha> --head <sha> [--slug <s>] [--root <dir>]`. */
export interface Args {
  readonly base?: string;
  readonly head?: string;
  readonly slug?: string;
  readonly root?: string;
}

/** `["--base", "aaa", "--head", "bbb"]` → `[["base","aaa"], ["head","bbb"]]`
 * — recursivo, sem mutar um acumulador (`--flag` sem valor, ou no fim do
 * array, é descartado). */
function paresChaveValor(argv: readonly string[]): readonly (readonly [string, string])[] {
  if (argv.length === 0) return [];
  const [chave, valor, ...resto] = argv;
  if (chave === undefined || !chave.startsWith("--") || valor === undefined) {
    return paresChaveValor(argv.slice(1));
  }
  return [[chave.slice(2), valor], ...paresChaveValor(resto)];
}

/** Parser posicional simples — sem dependência nova (AC da issue #48). */
export function parseArgs(argv: readonly string[]): Args {
  const pares = Object.fromEntries(paresChaveValor(argv));
  return {
    ...(pares["base"] !== undefined ? { base: pares["base"] } : {}),
    ...(pares["head"] !== undefined ? { head: pares["head"] } : {}),
    ...(pares["slug"] !== undefined ? { slug: pares["slug"] } : {}),
    ...(pares["root"] !== undefined ? { root: pares["root"] } : {}),
  };
}
