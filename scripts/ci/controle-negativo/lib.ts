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
 * `true` quando o `package.json` da base (JSON válido) não declara
 * `scripts.prova` — o harness (#42) ainda não existia naquele commit. Não
 * é uma falha do controle negativo: não há como rodar a prova ali, então
 * conta como PASS logado, não `vacuous-pass`.
 *
 * JSON inválido LANÇA — nunca vira `true` silenciosamente (rodada 2 da PR
 * #54: um `package.json` corrompido na base é uma falha real, diferente
 * de "harness ainda não existia"; `run.ts` distingue "arquivo ausente"
 * — que nem chega a chamar esta função — de "arquivo ilegível" — que
 * chama e deixa o `throw` propagar como FAIL explícito citando o caminho).
 */
export function semHarnessNaBase(packageJsonText: string): boolean {
  const pkg = JSON.parse(packageJsonText) as { scripts?: Record<string, unknown> };
  return typeof pkg.scripts?.["prova"] !== "string";
}

/**
 * `structural-red` só é aceito como controle negativo válido quando existe
 * PELO MENOS UM commit `test(red):` que toca os arquivos de teste do diff
 * (`run.ts#existeTestRedValido` também exige que esse mesmo commit
 * adicione um stub que lança — `contemStubQueLanca` abaixo). Rodada 2 da
 * PR #54: a regra original exigia isso do ÚLTIMO commit que toca os
 * testes, o que reprovava toda PR TDD normal (commit a cada verde depois
 * do vermelho) — reproduzido contra a própria PR #54 e a #52 já mergeada.
 */
const TEST_RED_RE = /^test\(red\):/;

export function ehCommitTestRed(subject: string): boolean {
  return TEST_RED_RE.test(subject.trim());
}

// `git show <sha> -- <arquivos-não-teste>` de um commit `test(red):` deve
// ter uma linha ADICIONADA (`+`, nunca o cabeçalho `+++ b/arquivo`) com
// `throw new Error(` — o stub que `worktree-segura` §7 pede para o
// vermelho compilar. Mesma convenção do Apollo (`hasDeclaredThrowingStub`,
// `.../tools/ci/lib/negative-control.mjs`); `(?!\+\+)` exclui o cabeçalho.
const THROWING_STUB_ADDED_RE = /^\+(?!\+\+).*\bthrow\s+new\s+Error\(/m;

/**
 * `true` quando o texto de um diff (`git show`) tem uma linha adicionada
 * com `throw new Error(` — verificado só nos arquivos NÃO-teste do commit
 * (`run.ts` filtra antes de chamar), para que um teste que apenas AFIRMA
 * "lança" (`expect(() => f()).toThrow(new Error(...))`) não passe por um
 * stub de produção de verdade.
 */
export function contemStubQueLanca(diffTexto: string): boolean {
  return THROWING_STUB_ADDED_RE.test(diffTexto);
}

// --- SKIP por classe (rodada 2 da PR #54, ADR 0004 item 7) ----------------
const DOCS_TOPO = new Set(["README.md", "CLAUDE.md", "AGENTS.md"]);
const DOCS_OU_PROCESS_PREFIXOS = ["docs/", ".claude/", ".github/"];

/** Classes `docs` e `process` da ADR 0004 item 7 — nada que este check
 * precise controlar (uma PR só de documentação ou de configuração de CI
 * não declara `prova/<slug>.ts`, e não deveria precisar). */
export function ehArquivoDocsOuProcess(arquivo: string): boolean {
  if (DOCS_TOPO.has(arquivo)) return true;
  return DOCS_OU_PROCESS_PREFIXOS.some((prefixo) => arquivo.startsWith(prefixo));
}

/**
 * `true` só quando o diff não é vazio E todo arquivo cai nas classes
 * `docs`/`process` — SKIP, exit 0, antes de sequer resolver o slug. Diff
 * vazio NÃO conta (não é "classe docs/process", é "nada mudou" — mantém o
 * comportamento anterior de reprovar quando `--base`/`--head` apontam pro
 * mesmo commit e não há `prova/<slug>.ts`).
 */
export function deveSerIgnorado(diff: readonly string[]): boolean {
  return diff.length > 0 && diff.every(ehArquivoDocsOuProcess);
}

// --- Shape de `resumo.json` (rodada 2 da PR #54) --------------------------
function ehFalhaValida(valor: unknown): valor is Falha {
  return (
    typeof valor === "object" &&
    valor !== null &&
    typeof (valor as { nome?: unknown }).nome === "string" &&
    typeof (valor as { motivo?: unknown }).motivo === "string"
  );
}

/**
 * Valida o shape de `resumo.json` lido da base antes de classificar — nunca
 * um `as Resumo` cego (mesmo espírito de `scripts/prova/vitest-relatorio.ts`:
 * um relatório ilegível não pode virar `empty-red`/PASS silencioso só
 * porque `ok` veio `undefined`). Lança citando `caminho` — `run.ts` propaga
 * isso como FAIL explícito.
 */
export function validarResumo(valor: unknown, caminho: string): Resumo {
  if (typeof valor !== "object" || valor === null) {
    throw new Error(`controle-negativo: ${caminho} não é um objeto`);
  }
  const bruto = valor as { ok?: unknown; total?: unknown; falhas?: unknown };
  if (typeof bruto.ok !== "boolean") {
    throw new Error(`controle-negativo: ${caminho} — "ok" precisa ser boolean`);
  }
  if (!Array.isArray(bruto.falhas) || !bruto.falhas.every(ehFalhaValida)) {
    throw new Error(
      `controle-negativo: ${caminho} — "falhas" precisa ser um array de {nome,motivo}`,
    );
  }
  const total = typeof bruto.total === "number" ? bruto.total : 0;
  return { ok: bruto.ok, total, falhas: bruto.falhas };
}

/** Argumentos de `npm run ci:controle-negativo -- --base <sha> --head <sha>
 * [--slug <s>] [--branch <ref>] [--root <dir>]`. `--branch` é para o
 * checkout detached do CI, onde `git branch --show-current` não resolve
 * nada — `run.ts` usa `--branch` como a branch a passar para
 * `resolveProvaSlug`/`branchSlug` quando `--slug` não vem explícito. */
export interface Args {
  readonly base?: string;
  readonly head?: string;
  readonly slug?: string;
  readonly branch?: string;
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
    ...(pares["branch"] !== undefined ? { branch: pares["branch"] } : {}),
    ...(pares["root"] !== undefined ? { root: pares["root"] } : {}),
  };
}
