// Funções puras do controle negativo (issue #48): nenhuma lê disco nem
// invoca git/npm — quem faz I/O é `run.ts`. Testável por fixtures diretas.
import type { Falha, Resumo } from "../../prova/tipos.js";

/** Os quatro desfechos possíveis de rodar a prova da PR contra a base. */
export type Desfecho = "assertion-red" | "structural-red" | "empty-red" | "vacuous-pass";

// --- Overlay: toda a classe tests/**+prova/** (issue #123) ----------------
// Uma única definição para duas perguntas antes distintas: "este arquivo é
// copiado de verdade da PR por cima da base?" (`arquivosDeTeste`, usada por
// `run.ts#overlay`) e "este arquivo cai na classe overlay para fins de SKIP?"
// (`ehArquivoDoOverlay`, usada por `ehDiffSoDoOverlay`/`soArquivosDoOverlay`
// mais abaixo). Antes da issue #123 elas divergiam: `arquivosDeTeste` só
// copiava `tests/**\/*.test.ts` e `prova/**` — um helper/fixture novo sob
// `tests/helpers/**` ficava fora do overlay real, e um teste que o
// importasse falhava de CARGA na base (`Cannot find module`), degradando
// `assertion-red` para `structural-red` (achado da rodada 2 da PR #119,
// reason 1 do veredito da PR #124).
const TESTES_PREFIXO_RE = /^tests\//;
const PROVA_RE = /^prova\//;

/** `true` para qualquer arquivo sob `tests/**` (não só `*.test.ts` —
 * fixtures/helpers contam) ou `prova/**`. */
export function ehArquivoDoOverlay(arquivo: string): boolean {
  return TESTES_PREFIXO_RE.test(arquivo) || PROVA_RE.test(arquivo);
}

/**
 * Filtra o diff da PR para os arquivos que compõem o overlay real aplicado
 * sobre a base (`run.ts#overlay`): a classe inteira `ehArquivoDoOverlay`
 * acima — todo `tests/**` (helpers/fixtures inclusos) e `prova/**` (a
 * própria declaração `prova/<slug>.ts`, que também precisa ir para a base —
 * sem ela `npm run prova -- <slug>` não sabe o que rodar lá).
 */
export function arquivosDeTeste(diff: readonly string[]): readonly string[] {
  return diff.filter((arquivo) => ehArquivoDoOverlay(arquivo));
}

/** Mais estreita que `ehArquivoDoOverlay`: só `tests/**\/*.test.ts` de
 * verdade, nunca uma fixture/helper. Não decide mais o que é copiado pelo
 * overlay (isso é `ehArquivoDoOverlay`, acima, desde a issue #123) —
 * sobrevive só como discriminador de "algum `.test.ts` JÁ EXISTIA na base e
 * foi EDITADO" em `existeTesteJaEditado`/`soArquivosDoOverlay`, mais abaixo
 * (lógica da lacuna 1 da issue #117, intacta). */
const TESTE_RE = /^tests\/.+\.test\.ts$/;

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
//
// Issue #62 excluía linhas que só COMENTAM o stub checando se a linha
// adicionada começava com `//`/`*` logo após o `+` — mas isso deixava
// passar (fail-open real, issue #78): um comentário de bloco de uma linha
// só (`/** throw new Error( */`, `/* throw new Error( */` — não começam
// com `//` nem com `*` sozinho) e um comentário de linha que não está no
// INÍCIO da linha (`x(); // throw new Error(`).
//
// Correção (issue #78): juntar todas as linhas ADICIONADAS do diff (sem o
// `+` do marcador, preservando a ordem — um comentário de bloco pode abrir
// numa linha e fechar noutra DESDE QUE as duas também sejam linhas
// adicionadas), remover dali os comentários de linha (`//` até o fim da
// linha) e de bloco (`/* … */`, non-greedy — pode juntar dois blocos
// separados por engano; aceitável, o objetivo é fail-closed, não um parser
// de verdade). Só então procura `throw new Error(` no que sobrar. Ignorar
// ocorrências dentro de strings não é necessário (mesma issue).
//
// A remoção de bloco completo sozinha não cobre dois casos em que só
// METADE do bloco foi capturada nas linhas adicionadas — o resto é linha
// de CONTEXTO (um `git show` de uma edição dentro de um bloco de comentário
// já existente):
//   - só a continuação foi tocada (abridor/fechador são contexto): a
//     heurística da #62 — excluir linha que começa com `*`, depois de
//     remover comentários de linha/bloco — continua necessária: código de
//     produção de verdade nunca começa uma linha assim.
//   - só o abridor foi tocado (o fechador `*/` é contexto): sobra um `/*`
//     sem par no texto extraído; removido explicitamente até o fim da
//     linha, pelo mesmo motivo — nenhum código de produção de verdade
//     carrega um `/*` desacompanhado até o fim da linha.
const LINHA_ADICIONADA_RE = /^\+(?!\+\+)(.*)$/gm;
const LINHA_CONTINUACAO_DE_BLOCO_RE = /^\s*\*/;
const ABRIDOR_DE_BLOCO_SEM_PAR_RE = /\/\*.*$/gm;
const THROW_NEW_ERROR_RE = /\bthrow\s+new\s+Error\(/;

/** Conteúdo (sem o `+`) de cada linha ADICIONADA de um diff, na ordem
 * original — nunca o cabeçalho `+++ b/arquivo` (`(?!\+\+)` exclui). */
function linhasAdicionadas(diffTexto: string): string {
  return Array.from(diffTexto.matchAll(LINHA_ADICIONADA_RE))
    .map((match) => match[1] ?? "")
    .join("\n");
}

/** Remove comentários de bloco (completos, e abridores sem fechador no
 * texto extraído) e de linha, e qualquer linha remanescente que seja só a
 * continuação de um bloco cujo abridor não foi capturado (ver os dois
 * casos acima de `LINHA_CONTINUACAO_DE_BLOCO_RE`/`ABRIDOR_DE_BLOCO_SEM_PAR_RE`). */
function removerComentarios(codigo: string): string {
  const semBlocoCompleto = codigo.replace(/\/\*[\s\S]*?\*\//g, "");
  const semBlocoNemLinha = semBlocoCompleto
    .replace(ABRIDOR_DE_BLOCO_SEM_PAR_RE, "")
    .replace(/\/\/.*$/gm, "");
  return semBlocoNemLinha
    .split("\n")
    .filter((linha) => !LINHA_CONTINUACAO_DE_BLOCO_RE.test(linha))
    .join("\n");
}

/**
 * `true` quando o texto de um diff (`git show`) tem uma linha adicionada
 * com `throw new Error(` fora de comentário — verificado só nos arquivos
 * NÃO-teste do commit (`run.ts` filtra antes de chamar), para que um teste
 * que apenas AFIRMA "lança" (`expect(() => f()).toThrow(new
 * Error(...))`) não passe por um stub de produção de verdade, nem um
 * comentário (de linha ou de bloco) que só menciona o padrão.
 */
export function contemStubQueLanca(diffTexto: string): boolean {
  return THROW_NEW_ERROR_RE.test(removerComentarios(linhasAdicionadas(diffTexto)));
}

// --- SKIP por classe (rodada 2 da PR #54, ADR 0004 item 7) ----------------
// Acréscimo à issue #62 (bloqueava a #65): `scripts/github/**` é tooling de
// GitHub (ruleset, labels) — processo, igual a `.claude/**`/`.github/**`,
// nunca comportamento a controlar; `.worktreeinclude` é o único arquivo de
// processo hoje no topo do repo além de `README.md`/`CLAUDE.md`/`AGENTS.md`
// (`lefthook.yml` não existe neste repositório).
const DOCS_TOPO = new Set(["README.md", "CLAUDE.md", "AGENTS.md", ".worktreeinclude"]);
const DOCS_OU_PROCESS_PREFIXOS = ["docs/", ".claude/", ".github/", "scripts/github/"];

/** Classes `docs` e `process` da ADR 0004 item 7 — nada que este check
 * precise controlar (uma PR só de documentação ou de configuração de CI
 * não declara `prova/<slug>.ts`, e não deveria precisar). Note que
 * `scripts/**` fora de `scripts/github/` continua FORA desta classe — é
 * exatamente o tipo de mudança comportamental (`scripts/ci/**`,
 * `scripts/prova/**`) que este check existe para controlar. */
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

// --- SKIP: só declaração de prova já existente editada (acréscimo à #62,
// bloqueava a #65) -----------------------------------------------------
const DECLARACAO_DE_PROVA_RE = /^prova\/[^/]+\.ts$/;

/** `true` só para `prova/<slug>.ts` — um único segmento sob `prova/`, nunca
 * `prova/sub/x.ts` nem um arquivo de teste em `tests/`. */
export function ehDeclaracaoDeProva(arquivo: string): boolean {
  return DECLARACAO_DE_PROVA_RE.test(arquivo);
}

/**
 * SKIP adicional: depois de tirar as classes `docs`/`process`
 * (`ehArquivoDocsOuProcess`), se tudo que sobra são declarações de prova
 * (`prova/<slug>.ts`) que JÁ EXISTIAM na base — só metadado de "quais
 * testes essa issue já declarada roda" mudou, nenhum `tests/**`, `src/**`
 * nem `scripts/**` (fora de `scripts/github/`, já coberto acima) entrou no
 * diff — não há comportamento novo para provar vermelho. Uma declaração
 * NOVA (`prova/<slug>.ts` ausente na base) continua exigindo controle: é
 * exatamente o caso normal de uma PR de feature. `provaJaExisteNaBase` é
 * injetado — quem faz I/O (`git cat-file -e base:<arquivo>`) é `run.ts`.
 *
 * NÃO é caso particular de `soArquivosDoOverlay` (abaixo, issue #114) — são
 * irmãs, cada uma testando "já existia na base" no seu próprio universo de
 * arquivo (`prova/<slug>.ts` aqui, `tests/**` lá). Um diff com só uma
 * declaração de prova (nova ou editada) e nenhum `tests/**` nunca satisfaz
 * `soArquivosDoOverlay` (ela exige um `tests/**` editado) — por isso as duas
 * são checadas em sequência, cada uma com seu motivo.
 */
export function soDeclaracaoDeProvaExistenteEditada(
  diff: readonly string[],
  provaJaExisteNaBase: (arquivo: string) => boolean,
): boolean {
  const naoDocsOuProcess = diff.filter((arquivo) => !ehArquivoDocsOuProcess(arquivo));
  if (naoDocsOuProcess.length === 0) return false;
  return naoDocsOuProcess.every(
    (arquivo) => ehDeclaracaoDeProva(arquivo) && provaJaExisteNaBase(arquivo),
  );
}

// --- SKIP: diff inteiro cai no overlay (issue #114, bloqueava a PR #113) --
// PR só de teste (`tests/**`/`prova/**`, sem `src/**`/`scripts/**` de
// produção) faz o mecanismo de `run.ts` (overlay do HEAD sobre a base,
// `arquivosDeTeste`) reproduzir a própria base — base+overlay ≡ head — e o
// desfecho é sempre `vacuous-pass`, mesmo quando existe um `test(red):` real
// (caso concreto: PR #113/#111, `tests/prova-run.test.ts` +
// `prova/prova-run-timeout.ts`). Quando isso acontece, o controle não tem
// como discriminar — em vez de reprovar por construção, SKIP com motivo
// explícito e distinto dos outros dois, para o revisor conferir o
// `test(red):` manualmente.
//
// `ehArquivoDoOverlay` (topo do arquivo) é a mesma classe copiada de verdade
// por `arquivosDeTeste` desde a issue #123 — antes, ela era mais larga que o
// overlay real (`TESTE_RE`+`PROVA_RE`), o que fazia uma fixture "cair" na
// classe do SKIP sem nunca ter sido copiada de fato. `TESTE_RE`, mais
// estreita (só `tests/**\/*.test.ts`), continua sendo o discriminador de
// "algum `.test.ts` JÁ EXISTIA na base e foi EDITADO" — a premissa deste
// SKIP é que um TESTE (a asserção que a PR muda) foi editado, para o revisor
// conferir manualmente; uma fixture editada sozinha, sem nenhum `.test.ts`
// no diff, não tem asserção nenhuma para conferir e segue pelo mecanismo
// normal (`ehDiffSoDoOverlay`/`ehOverlayOnly`, ver `run.ts`).

function semDocsOuProcess(diff: readonly string[]): readonly string[] {
  return diff.filter((arquivo) => !ehArquivoDocsOuProcess(arquivo));
}

/**
 * `true` quando, depois de remover as classes `docs`/`process`
 * (`ehArquivoDocsOuProcess`), o diff é não vazio e cai inteiro em
 * `ehArquivoDoOverlay` — não distingue "editado" de "novo" (isso é
 * `soArquivosDoOverlay`, que decide o SKIP antecipado abaixo).
 *
 * Uso real (issue #117, lacuna 3): `run.ts` computa isto UMA VEZ em
 * `main()` e passa para `rodarCheck`. Se `rodarCheck` recebe `true` aqui, é
 * porque `soArquivosDoOverlay` já foi `false` antes (senão o SKIP já teria
 * disparado em `main()`, antes de sequer chegar em `rodarCheck`) — logo
 * nenhum `tests/**` do diff já existia (editado) na base: é sempre o caso
 * "teste novo, sem produção alguma". `rodarCheck` usa essa garantia para
 * decidir se um desfecho `vacuous-pass` pode, ainda assim, virar SKIP via
 * commit `test(red):` (ver o branch de `vacuous-pass` em `run.ts`).
 */
export function ehDiffSoDoOverlay(diff: readonly string[]): boolean {
  const resto = semDocsOuProcess(diff);
  return resto.length > 0 && resto.every(ehArquivoDoOverlay);
}

/** `true` quando algum arquivo do diff (já sem `docs`/`process`) é um
 * `tests/**\/*.test.ts` de verdade (`TESTE_RE` — nunca a `ehArquivoDoOverlay`
 * mais larga, que também aceita fixtures) que JÁ EXISTIA na base e não foi
 * deletado no head. `statusNoDiff` devolve o status do `git diff
 * --name-status` (`A`/`M`/`D`) — `run.ts` já tem esse dado (veio de
 * `gitDiffNameStatus`), zero I/O novo. O default (`() => "M"`) existe só
 * para os testes unitários de antes da #117 continuarem compilando e
 * passando sem edição (2 argumentos, nunca deletado); `run.ts` sempre
 * injeta o status real. */
function existeTesteJaEditado(
  diffSemDocsOuProcess: readonly string[],
  arquivoJaExisteNaBase: (arquivo: string) => boolean,
  statusNoDiff: (arquivo: string) => string,
): boolean {
  return diffSemDocsOuProcess.some(
    (arquivo) =>
      TESTE_RE.test(arquivo) && statusNoDiff(arquivo) !== "D" && arquivoJaExisteNaBase(arquivo),
  );
}

/**
 * `true` só quando, depois de remover as classes `docs`/`process`
 * (`ehArquivoDocsOuProcess`), o restante do diff é não vazio, cai inteiro em
 * `ehArquivoDoOverlay`, E existe pelo menos um `tests/**\/*.test.ts` que JÁ
 * EXISTIA na base (foi EDITADO, não criado) E não foi deletado no head.
 * `arquivoJaExisteNaBase` é injetado — quem faz I/O (`git cat-file -e
 * base:<arquivo>`) é `run.ts`, mesmo padrão de
 * `soDeclaracaoDeProvaExistenteEditada`.
 *
 * A exigência "editado, não novo" não está explícita na descrição da issue,
 * mas é necessária: sem ela, este SKIP capturaria também um `tests/<slug>
 * .test.ts` inteiramente NOVO sem nenhum `src/**` — exatamente o cenário
 * que a suíte de integração já cobre como `vacuous-pass`/`structural-red`
 * de verdade (`repoVacuousPass`, `repoStructuralRed("sem-test-red"|
 * "sem-stub")`, e os quatro testes de infraestrutura da base que usam
 * `escreverTeste` depois do commit de base — nenhum deles editado por esta
 * issue). Um teste novo sem produção nenhuma é precisamente "afirmação sem
 * prova" — o controle ainda consegue e deve reprovar isso (issue #117,
 * lacuna 3, ver o branch de `vacuous-pass` em `run.ts`). O caso real que
 * motivou a issue (PR #113/#111) sempre EDITA um `tests/**` já existente
 * (`tests/prova-run.test.ts`) — é aí que "base+overlay ≡ head" se aplica de
 * verdade: o próprio arquivo de teste, seu conteúdo final, é o que a
 * correção prova, e ele inteiro já está no overlay.
 *
 * Lacunas 1 e 2 da issue #117 (veredito da PR #116): (1) o `some` usava a
 * classe larga (qualquer `tests/**`, inclusive fixtures — hoje
 * `ehArquivoDoOverlay`) em vez de `TESTE_RE`. Na época, uma fixture já
 * existente na base não era overlaid de verdade (`arquivosDeTeste` só
 * copiava `TESTE_RE`+`PROVA_RE`), então "base+overlay ≡ head" era falso para
 * ela. Desde a issue #123, `arquivosDeTeste` usa `ehArquivoDoOverlay` —
 * fixtures também são copiadas —, mas `TESTE_RE` continua sendo o
 * discriminador aqui: a premissa deste SKIP é que um TESTE foi editado (a
 * asserção que o revisor confere manualmente via `test(red):`), não que
 * qualquer arquivo do overlay tenha mudado; uma fixture editada sozinha
 * (sem nenhum `.test.ts` já existente no diff) não tem asserção nenhuma
 * para conferir e segue pelo mecanismo normal (`ehOverlayOnly`, `run.ts`).
 * (2) um arquivo deletado (`status === "D"`) existe na base por definição
 * (é o que está sendo apagado) mas nunca existiu no head — deleção nunca
 * deveria contar como "editado".
 */
export function soArquivosDoOverlay(
  diff: readonly string[],
  arquivoJaExisteNaBase: (arquivo: string) => boolean,
  statusNoDiff: (arquivo: string) => string = () => "M",
): boolean {
  if (!ehDiffSoDoOverlay(diff)) return false;
  return existeTesteJaEditado(semDocsOuProcess(diff), arquivoJaExisteNaBase, statusNoDiff);
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
