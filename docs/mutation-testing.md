# Mutation testing

Como o repositório prova que os testes prendem comportamento, não só que
rodam. Descreve o que está em `scripts/mutations/` hoje; não é normativo
sobre o que deveria existir.

## Mecânica A — harness comum (`scripts/mutations/harness.ts`)

Cinco das seis fatias (todas menos `media`) seguem a mesma mecânica, extraída
para `harness.ts` (issue #148):

1. `prepareArchiveSandbox(root, candidateSha)` — recusa se
   `git status --porcelain` não estiver vazio, cria um `mkdtemp`, extrai
   `git archive --format=tar <sha> | tar -x` nele e faz symlink de
   `node_modules` do checkout real para dentro do sandbox. O runner nunca
   muta o checkout — só essa árvore descartável.
2. `applyEditExactlyOnce(directory, edit, id)` — lê `edit.file`, substitui
   `edit.before` por `edit.after` via `replaceExactlyOnce` (lança se a âncora
   não ocorrer exatamente uma vez: nem zero, nem duas) e escreve de volta.
3. `runFocusedVitest(directory, focus)` roda `vitest run <focus.file> -t
<focus.test> --reporter=json`; `runVitestFiles(directory, files)` roda uma
   lista de arquivos inteira sem afunilar por `-t` (o que `workflow-executor`
   usa: os 44 mutantes rodam a mesma bateria de `focalTests` completa a cada
   vez, em vez de um teste único por mutante).
4. `parseVitestOutcome(stdout, exitCode, stderr)` interpreta o JSON do vitest
   num `RunOutcome` determinístico (sem timestamp/duração). Lança se não
   achar um objeto JSON balanceado no stdout — falha do harness, não um
   veredito `killed: true` fabricado (veredito da PR #170).
5. `classify(exitCode, failedTests)` — um mutante só é `killed` quando o
   processo saiu com código diferente de zero **e** pelo menos um teste
   falhou nesse foco. As duas condições precisam valer juntas: um exit
   diferente de zero sem falha de teste (crash do harness) não é morte, e
   uma falha reportada com exit 0 (não deveria acontecer, mas o harness não
   confia nisso) também não conta.
6. `assertBaselineGreen(outcome, context)` — lança se o baseline (antes do
   mutante) não saiu com exit 0 e pelo menos um teste rodado; sem essa
   guarda, um `-t` obsoleto que não bate nenhum teste sairia `{exitCode: 0,
ranTests: 0}` e nunca provaria nada.
7. `restoreAll(directory, snapshot)` restaura os arquivos editados a partir
   de um snapshot byte a byte tirado antes do primeiro mutante
   (`snapshotFiles`). `assertRestoreGreen(outcome)` confere que o foco volta
   a ficar verde depois da restauração — vira o campo `restoreGreen` do
   relatório, não um fault fatal (o chamador guarda o resultado como dado).
8. `writeReport(dir, report)` escreve `dir/mutations.json` em JSON canônico
   (`canonical.ts`: chaves ordenadas, termina em newline).

Todo runner de verdade (`workflow-executor.ts`, `workflow-durability.ts`,
`workflow-audit-live.ts`, `web-tools.ts`, `self-update.ts`, e `media.ts` por
consistência de estilo) usa a mesma guarda de entry-point,
`ehEntryPoint(import.meta.url)` (issue #186): compara a URL do módulo
chamador com `process.argv[1]`, então `main()` só dispara quando o processo
foi invocado com aquele arquivo como script de entrada (`tsx
scripts/mutations/<runner>.ts`) — nunca quando um teste ou outro runner
importa o módulo. `tests/mutations-runner-guard.test.ts` prova isso para os
seis.

## Mecânica B — `media.ts`, em processo

`scripts/mutations/media.ts` (issue #151) não usa `harness.ts` para rodar o
mutante (só reaproveita `applyEditExactlyOnce` e `writeReport`): copia `src/`
inteiro para um diretório descartável (`cpSync`), aplica os `edits` do
mutante (vazio = a árvore restaurada) e faz `import()` dinâmico do módulo
resultante **dentro do mesmo processo** — sem subprocesso, sem vitest. O
oráculo não é um teste focal; é o `probe(module)` do próprio mutante
(`MediaMutant.probe`, `scripts/mutations/media-mutant.ts`), que devolve um
`actual` comparado a `expected` via `compareMediaRows`
(`media-comparator.ts`). Cada mutante roda o `probe` duas vezes: contra o
módulo mutado (decide `killed`) e contra uma cópia sem os edits, a "árvore
restaurada" (decide `restoreGreen`) — sem a segunda corrida, um `probe` cujo
`actual` nunca bate com `expected` apareceria sempre "killed", mutação ou
não.

## Formato de mutante e de relatório (`scripts/mutations/types.ts`)

```ts
interface Edit {
  file: string; // caminho relativo à raiz do sandbox/cópia
  before: string; // âncora exata; precisa ocorrer uma única vez
  after: string;
}

interface Focus {
  file: string; // arquivo de teste onde o oráculo mora
  test: string; // padrão `vitest -t` do teste que precisa matar o mutante
}

interface Mutant {
  id: string;
  category: string;
  mechanism: string;
  focus: Focus;
  edits: readonly Edit[];
}
```

`MediaMutant` (`media-mutant.ts`) é a variante da mecânica B: mesmos `id`/
`category`/`edits`, mas troca `focus` por `entry` (módulo sob teste,
relativo a `src/`), `expected` (o oráculo) e `probe` (a função que produz
`actual`).

Cada runner escreve um `MutationReport`:

```ts
interface MutationReport {
  suite: string;
  candidateSha: string;
  killed: number;
  total: number;
  survivors: readonly string[];
  restoreGreen: boolean;
  byCategory?: Readonly<Record<string, number>>;
  mutants?: readonly MutantResult[]; // opcional: nem todo runner popula
}
```

## `scripts/mutations/slices.json` e a contagem real por fatia

Seis fatias, cada uma com `slice`, `script` (chave de `package.json#scripts`),
`catalog` (arquivos de dado puro que a compõem), `srcGlobs` (o que em `src/`
essa fatia cobre) e `focusFiles` (união dos `focus.file` dos mutantes, exceto
`media`, que não tem `focus`, e `workflow-executor`, que usa a bateria
inteira de `focalTests` em vez de um foco por mutante):

| fatia                 | script                  | mutantes | catálogo(s)                                                                                                           |
| --------------------- | ----------------------- | -------: | --------------------------------------------------------------------------------------------------------------------- |
| `workflow-executor`   | `mutations:t15`         |       44 | `workflow-executor-mutants.ts`                                                                                        |
| `workflow-durability` | `mutations:t16`         |       57 | `workflow-durability-guard.ts` (12 guard + 2 combined) + `workflow-durability-named.ts` (38) + `orchestration.ts` (5) |
| `workflow-audit-live` | `mutations:t17`         |       32 | `workflow-audit-live-mutants.ts`                                                                                      |
| `media`               | `mutations:t21`         |       20 | `media-catalog-persistence.ts` (13) + `media-catalog-other.ts` (7)                                                    |
| `web-tools`           | `mutations:t20`         |        9 | `web-tools-mutants.ts`                                                                                                |
| `self-update`         | `mutations:self-update` |        8 | `self-update-mutants.ts`                                                                                              |

Total: 170. Os 12 mutantes de `workflow-durability-guard.ts` são
combinatórios: três conjuntos do guard de escrita possuída (`fence`,
`holder`, `lease-validity`) × quatro categorias (`state`, `cache`,
`node-cost`, `spend`) — um mutante por combinação, cada um escorado só no
teste focal da sua categoria, mais os 2 mutantes do INSERT combinado
cache+custo (`combined-cell-guard-removed`,
`combined-cost-escapes-refusal`). `tests/mutations-slices.test.ts` importa os
nove catálogos de dado puro estaticamente e prova essa soma (170) a cada
corrida — a contagem acima não pode driftar do JSON sem reprovar esse teste.

## `npm run mutations:all` — o agregador (issue #155)

`scripts/mutations/all.ts` lê `slices.json` e roda cada `script` por
subprocesso (`npm run <script>`, nunca por `import`: os runners chamam
`main()` incondicionalmente sob a guarda de entry-point, então importar
dispararia a corrida errada) até duas vezes — a segunda corrida só acontece
se a primeira não reprovar (sobrevivente ou `restoreGreen: false`), para não
gastar até 20 minutos de novo numa fatia já reprovada.

Falha (`process.exitCode = 1`), com o motivo no stderr:

- `MUTATION_SURVIVOR:<fatia>:<id>` — sobrevivente numa das corridas.
- `MUTATION_RESTORE_NOT_GREEN:<fatia>` — `restoreGreen: false`.
- `MUTATION_NONDETERMINISTIC:<fatia>` — os digests (`sha256` da linha JSON
  bruta) das duas corridas da mesma fatia divergem.
- `MUTATION_ALL_KILLED:<fatia>` — o subprocesso morreu por sinal (inclusive
  timeout do `spawnSync`) antes de produzir relatório.

Política: **qualquer sobrevivente bloqueia** — não há limiar. Sucesso escreve
`.mutation-evidence/all.json` (`{candidateSha, slices: [{slice, script,
suite, candidateSha, killed, total, survivors, restoreGreen, digest}]}`),
gitignorado. Este é o gate de mutação único do passo 11 de
`.claude/rules/orquestracao.md` para merges de risco.

## Como adicionar um mutante

1. Escolher a fatia (pela pasta de `src/` que o mutante mira) e o catálogo
   correspondente em `scripts/mutations/slices.json#catalog`.
2. Adicionar uma entrada ao array exportado do catálogo:
   `{ id, category, mechanism, focus: { file, test }, edits: [{ file,
before, after }] }` (ou o shape `MediaMutant` para a fatia `media`).
   `before` precisa ser uma âncora que ocorre exatamente uma vez no arquivo
   alvo — `replaceExactlyOnce` lança se não ocorrer ou se ocorrer mais de
   uma vez.
3. Se o `focus.file` for novo para a fatia, acrescentá-lo a
   `slices.json#focusFiles` dessa fatia (exceto `media`/`workflow-executor`,
   que não usam essa lista da forma normal — ver comentário do teste).
4. Rodar o script da fatia (`npm run <script>` de `slices.json`) e conferir
   que o novo mutante aparece `killed: true` e que `restoreGreen` continua
   `true`.
5. `npm test` roda `tests/mutations-slices.test.ts`, que reprova se a
   contagem total (170 + o novo) não bater com a soma dos catálogos
   importados — o teste precisa de uma atualização do literal `170` junto
   com o mutante novo.

## Como adicionar uma fatia

1. Criar o(s) arquivo(s) de catálogo de dado puro em `scripts/mutations/`
   (padrão `*-mutants.ts` ou `*catalog*.ts`) e o runner que os consome sobre
   `harness.ts` (mecânica A) ou seguindo `media.ts` (mecânica B).
2. Adicionar a entrada em `scripts/mutations/slices.json`: `slice`, `script`,
   `catalog`, `srcGlobs` (um glob `src/<dir>/**` por diretório de primeiro
   nível de `src/` que a fatia cobre), `focusFiles`.
3. Adicionar o script em `package.json#scripts` com o mesmo nome de
   `slices.json#script`.
4. Importar o(s) catálogo(s) novo(s) em `tests/mutations-slices.test.ts`
   (mapa `CATALOGOS`) e remover o(s) diretório(s) agora cobertos da lista
   `SEM_FATIA` desse mesmo arquivo.

`tests/mutations-slices.test.ts` prova, a cada corrida: o schema básico de
cada entrada de `slices.json`; que todo catálogo em disco
(`*-mutants.ts`/`*catalog*.ts`) aparece em algum `catalog`; que os `catalog`
do JSON batem, como conjunto, com os nove catálogos importados em
`CATALOGOS`; que todo `script` existe em `package.json#scripts`; que todo
`focusFiles`/`catalog` existe em disco; que `focusFiles` bate com a união de
`focus.file` dos catálogos da fatia (exceto `media`/`workflow-executor`); a
soma de 170; e que todo diretório de primeiro nível de `src/` está coberto
por algum `srcGlobs` ou está em `SEM_FATIA` com um motivo não vazio — nunca
os dois, nunca nenhum dos dois.

## Diretórios de `src/` sem fatia hoje

Dezoito diretórios de primeiro nível de `src/` não têm catálogo de mutação:
`agent`, `auth`, `catalog`, `config`, `context`, `conversation`, `core`,
`cron`, `doctor`, `events`, `memory`, `onboarding`, `pricing`, `providers`,
`serialization`, `server`, `skills`, `transports` — listados em
`tests/mutations-slices.test.ts` (`SEM_FATIA`), cada um com o motivo "sem
catálogo de mutantes ainda". Os onze diretórios cobertos hoje: `workflow`,
`state`, `orchestration` (fatia `workflow-durability`); `cli`, `commands`
(também em `workflow-audit-live` e `self-update`); `media`, `tools` (fatia
`media`, também em `self-update`); `web` (fatia `web-tools`); `self-update`,
`mcp`, `gateway` (fatia `self-update`).

## CI e o que ainda não está em `main`

`mutations.yml` — o workflow que roda a fatia certa por path em cada PR,
usando `srcGlobs` de `slices.json` para decidir quais fatias rodar (issue
#156) — está na PR #188, ainda não mergeada. O harness rodando dentro do
Actions (em vez de só localmente) é a issue #191. Até essas duas fecharem, o
gate de mutação (`npm run mutations:all`) roda localmente, e o passo 11 de
`orquestracao.md` (QA em merge de risco) é quem o exercita.
