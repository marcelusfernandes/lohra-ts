# Mutation testing

Como o repositório prova que os testes prendem comportamento, não só que
rodam. Descreve o que está em `scripts/mutations/` hoje; não é normativo
sobre o que deveria existir.

## Mecânica A — harness comum (`scripts/mutations/harness.ts`)

Oito das nove fatias (todas menos `media`) seguem a mesma mecânica, extraída
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
<focus.test>`. `focus.test` é o título **literal** do teste, não um padrão
   de regex: `escapeFocusTest` (issue #362) escapa os metacaracteres antes do
   `-t`, sem ancorar em `^…$` — o vitest casa `-t` contra o `fullName`
   (`ancestorTitles` do `describe` + título do `it`), e os catálogos hoje
   passam só o título do `it`, sem o prefixo do `describe`; ancorar quebraria
   esse casamento por SUBSTRING (veredito da PR #371/#362: um título que é
   substring de outro título de foco focalizaria os dois ao mesmo tempo —
   hoje nenhum dos títulos de foco em uso é substring de outro).
   `runVitestFiles(directory, files)` roda uma lista de arquivos
   inteira sem afunilar por `-t` (o que `workflow-executor` usa: os 45
   mutantes rodam a mesma bateria de `focalTests` completa a cada vez, em vez
   de um teste único por mutante). As duas delegam a `runVitestReporterJson`
   (`harness.ts:182-207`, issue #191): monta os args com `vitestArgs`
   (`--reporter=json --outputFile=<arquivo>`, `harness.ts:171-173`), aponta o
   `outputFile` para dentro de um `mkdtemp` descartável
   (`lohra-vitest-out-`), roda o `spawnSync` e só então lê o relatório do
   arquivo — nunca do stdout capturado (no runner ubuntu do Actions, o
   dispositivo de saída padrão do processo filho é um socket que `open()`
   recusa com `ENXIO`) — removendo o diretório temporário no `finally`, com
   ou sem erro. Arquivo ausente (o vitest falhou antes de escrevê-lo) vira
   relatório vazio (`""`) passado a `parseVitestOutcome`.
4. `parseVitestOutcome(stdout, exitCode, stderr)` interpreta o conteúdo do
   relatório (lido do arquivo pelo chamador, apesar do nome do parâmetro) num
   `RunOutcome` determinístico (sem timestamp/duração). Lança se não achar um
   objeto JSON balanceado — falha do harness, não um veredito `killed: true`
   fabricado (veredito da PR #170) — com a mensagem
   `vitest produced no JSON report (exitCode=<code>): <stderr>`
   (`harness.ts:148`).
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
`workflow-audit-live.ts`, `web-tools.ts`, `self-update.ts`, `media.ts` por
consistência de estilo, `context-window.ts`, `auth.ts` e `supervision.ts`)
usa a mesma guarda de entry-point, `ehEntryPoint(import.meta.url)` (issue
#186): compara a URL do módulo chamador com `process.argv[1]`, então
`main()` só dispara quando o processo foi invocado com aquele arquivo como
script de entrada (`tsx scripts/mutations/<runner>.ts`) — nunca quando um
teste ou outro runner importa o módulo. `tests/mutations-runner-guard.test.ts`
prova isso por subprocesso isolado para os oito da allowlist `RUNNERS`
daquele teste; `context-window.ts` (issue #293) entrou nela na issue #297 —
antes disso ficava fora (arquivo fora do `Files` da issue #293) e a prova
era só indireta, via `tests/mutations-t23-catalog.test.ts` e
`tests/mutations-slices.test.ts` importando `contextWindowMutants`
estaticamente a cada `npm test` (um `main()` disparado no import travaria a
suíte inteira). `auth.ts` (issue #354) entrou na mesma allowlist desde o
início. `supervision.ts` (issue #451) segue fora dela — mesma situação que
`context-window.ts` tinha antes da #297 (`tests/mutations-runner-guard.test.ts`
não está no `Files` desta issue) — com a mesma prova indireta: a importação
estática de `supervisionMutants` em `tests/mutations-slices.test.ts` a cada
`npm test`.

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
  test: string; // título literal do teste que precisa matar o mutante (escapado antes do -t, #362)
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

Nove fatias, cada uma com `slice`, `script` (chave de `package.json#scripts`),
`catalog` (arquivos de dado puro que a compõem), `srcGlobs` (o que em `src/`
essa fatia cobre) e `focusFiles` (união dos `focus.file` dos mutantes, exceto
`media`, que não tem `focus`, e `workflow-executor`, que usa a bateria
inteira de `focalTests` em vez de um foco por mutante):

### Forma dos `srcGlobs`

`srcGlobs` só aceita duas formas (`scripts/github/mutations-matrix.ts:44-62`,
`DIR_GLOB_FORM`/`FILE_GLOB_FORM`, fail-closed): `src/<dir>/**` — um
diretório de primeiro nível de `src/`, inteiro — ou o literal
`src/<arquivo>.ts` — um arquivo de topo, direto em `src/`. Não existe uma
terceira forma para arquivo em subdiretório: `src/conversation/compaction.ts`
não é um `srcGlobs` válido, só `src/conversation/**` (o diretório inteiro)
cobre esse arquivo. Qualquer outra forma faz `globDir` lançar
`srcGlobs: formato inesperado (esperava "src/<dir>/**" ou
"src/<arquivo>.ts")`. Foi o que a issue #293 tropeçou ao propor um glob por
arquivo para `compaction.ts`; a fatia `context-window` acabou com cinco
`srcGlobs` de diretório inteiro (ver a tabela abaixo) — o passo 2 de "Como
adicionar uma fatia" cita a mesma restrição.

| fatia                 | script                  | mutantes | catálogo(s)                                                                                                           |
| --------------------- | ----------------------- | -------: | --------------------------------------------------------------------------------------------------------------------- |
| `workflow-executor`   | `mutations:t15`         |       45 | `workflow-executor-mutants.ts`                                                                                        |
| `workflow-durability` | `mutations:t16`         |       60 | `workflow-durability-guard.ts` (12 guard + 2 combined) + `workflow-durability-named.ts` (41) + `orchestration.ts` (5) |
| `workflow-audit-live` | `mutations:t17`         |       57 | `workflow-audit-live-mutants.ts` (32) + `workflow-audit-producers-mutants.ts` (25)                                    |
| `media`               | `mutations:t21`         |       20 | `media-catalog-persistence.ts` (13) + `media-catalog-other.ts` (7)                                                    |
| `web-tools`           | `mutations:t20`         |        9 | `web-tools-mutants.ts`                                                                                                |
| `self-update`         | `mutations:self-update` |        8 | `self-update-mutants.ts`                                                                                              |
| `context-window`      | `mutations:t23`         |       15 | `context-window.ts`                                                                                                   |
| `auth`                | `mutations:auth`        |       13 | `auth-mutants.ts`                                                                                                     |
| `supervision`         | `mutations:supervision` |       20 | `supervision-mutants.ts`                                                                                              |

Total: 247. Os 12 mutantes de `workflow-durability-guard.ts` são
combinatórios: três conjuntos do guard de escrita possuída (`fence`,
`holder`, `lease-validity`) × quatro categorias (`state`, `cache`,
`node-cost`, `spend`) — um mutante por combinação, cada um escorado só no
teste focal da sua categoria, mais os 2 mutantes do INSERT combinado
cache+custo (`combined-cell-guard-removed`,
`combined-cost-escapes-refusal`). `tests/mutations-slices.test.ts` importa os
treze catálogos de dado puro estaticamente e prova essa soma (247) a cada
corrida — a contagem acima não pode driftar do JSON sem reprovar esse teste.

`supervision-mutants.ts` (issue #451, milestone 14 — achado de QA/revisão de
M10, épico #421) é o décimo terceiro catálogo, fatia nova: 227 + 19 = 246.
`npm run mutations:all` seguia 227/227 apesar de ~1.000 linhas novas em M10
(steer, leaf_read, route-faults, route-override, `dead_turn`) sem nenhum
mutante dedicado — 19 mutantes cobrindo `src/workflow/{steer-tool,
leaf-read-tool,route-faults,route-override}.ts`, `MAX_PENDING_STEERS_PER_LEAF`
em `src/orchestration/core.ts`, o guard de `dead_turn` em
`src/orchestration/child-runner.ts` e o vocabulário fechado de
`src/transports/error-kinds.ts`. `transports` sai de `SEM_FATIA` — a primeira
fatia a cobrir esse diretório. `srcGlobs` é `src/workflow/**` +
`src/orchestration/**` + `src/transports/**` (diretório inteiro cada, única
forma válida) — as duas primeiras já eram cobertas por `workflow-durability`/
`workflow-audit-live`, então a fatia nova dispara em paralelo a essas, não em
lugar delas. A issue #452 (pivô de rota em sub-workflow por ref, PR #472)
mergeou em paralelo a esta issue e acrescentou `overrideNestedSpec`
(route-override.ts) e sua chamada em `engine.ts`'s `runNested` — mais um
mutante (O5, morto por `tests/workflow-route-override-nested.test.ts`): 246

- 1 = 247.

`workflow-executor-mutants.ts` (issue #418) acrescentou
`Q1-quota-guard-removed`: a guarda que impede `quota_exhausted` de entrar em
`fault_kinds`, morta por `tests/workflow-fault-kinds.test.ts` (issue #412) —
o sexto arquivo de `focalTests`/`focusFiles` da fatia (44 → 45). Issue #426
generalizou a guarda de `!== QUOTA_EXHAUSTED` para `!pausesRun(...)`
(`engine-utils.ts:487`, também cobre os três kinds de rota) — mesmo id de
mutante, `before`/`after` re-ancorados na mesma PR.

`workflow-audit-producers-mutants.ts` (issue #370) estende `workflow-audit-live`
aos produtores novos do M7 que os 32 mutantes originais não cobriam:
`segment_id` omitido, a regra fail-closed desligada e o flush antes de
liberar a lease pulado (`audit-producers.ts`, identidade causal #365), a
ordem `segment.started`/`workflow.plan` e o `process_crash` de uma retomada
de dono morto (`audit-producers.ts`, #368), o terminal único por `sub_id`, o
timeout como `cancelled` e o `node_path` achatado numa folha aninhada
(`audit-runtime.ts`, folhas #366), a identidade e a classificação de uma
recusa síncrona do sandbox (`audit-runtime.ts`, ferramentas #367), um hit de
cache relatado como miss e uma escrita recusada relatada como armazenada
(`audit-cache.ts`, #368), e o teto de bytes, o desconto por bytes na janela,
a contagem de `dropped`, o teto de runs conhecidos evictando um run vivo e o
cursor regredindo em `forget()` (`live-tail.ts`, #369). Os 18 mutantes
originais têm foco nos seis arquivos de teste novos do M7
(`workflow-audit-identity`, `-leaf`, `-tool`, `-cache`, `-segment`,
`workflow-live-tail`).

Quatro mutantes da tabela inicial da issue #370 ficaram de fora,
deliberadamente: `P5-crash-on-clean-resume` (`service.ts` ou produtores — um
`orphaned` ignorado sempre gravaria crash, foco `workflow-audit-segment`),
`L3-attempt-zeroed` (`audit-runtime.ts` — `attempt` fixo em 0, foco
`workflow-audit-leaf`), `R2-drop-newest` (`live-tail.ts` — descarta o mais
novo em vez do mais velho, foco `workflow-live-tail`) e
`W1-watch-events-repeat` (`src/commands/workflow.ts` — cursor não avança,
foco `workflow-watch-events`). `R2-drop-newest` já havia sido tentado:
sobreviveu à primeira corrida real (nenhum teste prendia a ordem FIFO da
evicção) e foi trocado por `R2-byte-trim-disabled`, deixando a lacuna de
oráculo aberta; `L4-wait-false-closes` (`collect()` com `wait:false`
retornando `"running"`) e a allow-list de `event_type` aceitando string
livre (`audit-model.ts`) eram outras duas lacunas da mesma lista, sem `id`
formal na tabela inicial.

A issue #383 fecha DUAS das quatro lacunas nomeadas acima — `R2`
(agora `R6-drop-newest`, já que o `id` `R2` estava reaproveitado por
`R2-byte-trim-disabled`) e `W1` (mesmo `id`, `W1-watch-events-repeat`, agora
um mutante real) — mais cinco mutantes novos, sete no total (18 → 25):
`L4-wait-false-closes` e `M1-allowlist-free-string` (a allow-list de
`event_type` em `audit-model.ts`, ancorada na CHECAGEM, não no conteúdo do
`SAFE_EVENT_TYPES`), `W2-audit-trail-warning-unwired` (a fiação
`{ warning: auditWarning }` do `AuditTrail` de `chat.ts`, veredito da PR
#384/#380), `T3-cancel-flush-skipped` (o laço de flush de `close()` para
dispatches de ferramenta ainda abertos, veredito da PR #385) e
`PD-pending-never-reported` (o relato de `pending` de `workflow_audit`,
issue #373/PR #389). `P5-crash-on-clean-resume` e `L3-attempt-zeroed`
continuam de fora — fora do escopo de #383.

`auth-mutants.ts` (issue #354, +4 na rodada 1 e +1 na rodada 2 da issue
#356) cobre a lease de arquivo sobre a renovação do token OAuth
(`src/auth/lease.ts`: TTL zerado, lease órfã não tomada de volta, release
sem checar o dono) e a coordenação em `src/auth/credentials.ts` (janela de
"ainda expirando" zerada, o ramo que adota o token que outro processo já
escreveu, a identidade de `RefreshFailedError` quando o refresh falha de
verdade, e a identidade de `TokenPersistError` quando o refresh funciona
mas a escrita em disco falha — issue #354, achado 2 da PR #352: essa
escrita vive fora do `try` do POST). Os 4 mutantes da rodada 1 da issue
#356 cobrem o fail-closed de `isLeaseAlive` para um lock ilegível
(fallback por `mtime + ttlSeconds` desativado), o dono pulando a releitura
sob a lease antes de repetir o refresh, o deadline do perdedor em
`waitForFileLease` (`>=` virando `>`), e a identidade de
`TokenPersistError` quando `acquireFileLease` propaga um erro real (não
`EEXIST`) em vez de `RefreshFailedError`. O mutante da rodada 2 cobre
`waitForFileLease` deixando de usar `isLeaseAlive` para um lock ilegível
persistente (os dois leitores da lease voltando a discordar sobre o que é
"viva"). Todos os 13 mutantes têm foco em `tests/auth-core.test.ts`.

`context-window.ts` (issue #293) é o único catálogo que também é o próprio
runner — o `Files` da issue só autoriza um script novo, então os 15 mutantes
(`export const contextWindowMutants`) e a corrida (`main()`, atrás da mesma
guarda de entry-point dos outros seis) moram no mesmo arquivo, ao contrário
de `web-tools.ts`/`web-tools-mutants.ts` (runner e catálogo separados). Cobre
a compactação preflight (`src/conversation/compaction.ts`: limiar de
`compactionThreshold`, `CONSERVATIVE_RESERVE_RATIO`, corte de cauda alinhado
a turno), o latch de uma compactação por turno e o fail-open sem repositório
compactável (`src/conversation/runtime.ts`), o estimador de tokens ignorando
`tool_result`/overhead de mensagem (`src/context/token-estimate.ts`), a
precedência de `resolveContextWindow` e o separador do prefixo
(`src/providers/context-window.ts`), a fusão por modelo e o teto na leitura
do cache de janelas (`src/catalog/windows-cache.ts`) e o `compactHistory` da
issue #252 — lock checado na transação, `message_count` líquido e o filtro
`active` de `loadMessages` (`src/state/session-repository.ts`).

## `npm run mutations:all` — o agregador (issue #155)

`scripts/mutations/all.ts` lê `slices.json` e roda cada `script` por
subprocesso (`npm run <script>`, nunca por `import`: os runners chamam
`main()` incondicionalmente sob a guarda de entry-point, então importar
dispararia a corrida errada) até duas vezes — a segunda corrida só acontece
se a primeira não reprovar (sobrevivente ou `restoreGreen: false`), para não
gastar até 20 minutos de novo numa fatia já reprovada.

Falha (`process.exitCode = 1`), com o motivo no stderr (cabeçalho de
diagnóstico em `all.ts:18-43`; `evaluateRun`, `all.ts:214-228`, nomeia a
causa a partir do `RunResult` bruto do subprocesso):

- `MUTATION_SURVIVOR:<fatia>:<id>` — sobrevivente numa das corridas
  (`assertRunClean`, `all.ts:232-238`).
- `MUTATION_RESTORE_NOT_GREEN:<fatia>` — `restoreGreen: false` (mesma
  função).
- `MUTATION_NONDETERMINISTIC:<fatia>` — os digests (`sha256` da linha JSON
  bruta) das duas corridas da mesma fatia divergem (`runSliceTwice`,
  `all.ts:255`).
- `MUTATION_ALL_TIMEOUT:<fatia>` — o próprio `spawnSync` matou o processo por
  estourar `timeout` (`error.code === "ETIMEDOUT"`, `isTimeoutError`,
  `all.ts:181-183`) — a causa que o comentário histórico dizia cobrir mas que
  antes era interceptada sem nomear a fatia.
- `MUTATION_ALL_KILLED:<fatia>:<SIGKILL|SIGTERM|128+n>` — morte por sinal.
  Dois caminhos viram a mesma causa (`evaluateRun`, `all.ts:220-223`): sinal
  reportado direto pelo `spawnSync` (`run.signal !== null`, comum no macOS)
  ou `status >= 128` sem `signal`. O segundo caminho existe porque
  `npm run <script>` sempre passa por um shell (`sh -c`) entre o `spawnSync`
  e o script de verdade, e no Linux da CI esse shell converte morte por
  sinal num código de saída 128+n (137 = 128+SIGKILL, 143 = 128+SIGTERM) em
  vez de propagar `signal`. O nome vem de `signalNameForExitCode` (`all.ts:195-197`),
  derivado de `os.constants.signals` — sem nenhum `process.platform` no
  runtime; um código sem sinal conhecido cai para o literal `128+<n>`.
- `MUTATION_ALL_EXIT:<fatia>:<status>` — o relatório saiu limpo (JSON válido,
  sem sobrevivente) mas o processo terminou com `status !== 0` — runner que
  imprime e morre depois, no `finally` ou por unhandled rejection
  (`all.ts:226`). Sem essa checagem esse caso passaria como verde.
- `MUTATION_ALL_NO_REPORT:<fatia>` — nenhuma linha de `stdout+stderr` parece
  um objeto JSON completo (`extractJsonLine`, `all.ts:150`).
- `MUTATION_ALL_BAD_REPORT:<fatia>[:<campo>]` — a linha achada não tem o
  shape mínimo de `ParsedSliceReport` (`parseSliceReport`, `all.ts:156-171`).

`scripts/mutations/slices.json` pode ser trocado pela variável de ambiente
`MUTATIONS_ALL_SLICES_PATH` (relativa à raiz do repo, ou absoluta;
`resolveSlicesPath`, `all.ts:115-119`) — só para o teste do entrypoint em
subprocesso; `main()` não recebe outro caminho.

Nota: o `qa` roda os `mutations:*` de um merge de risco no worktree isolado
da própria PR (`isolation: worktree`, `.claude/agents/qa.md:5,12`), nunca no
checkout `main` compartilhado (issue #197).

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
5. `npm test` roda `tests/mutations-slices.test.ts`, que reprova de duas
   formas se a contagem não for atualizada junto com o mutante novo: a soma
   total (247 + o novo) contra os treze catálogos importados, e a linha do
   catálogo tocado em `CONTAGEM_POR_CATALOGO`
   (`tests/mutations-slices.test.ts:515-534`), uma tabela pinada por número
   literal — não derivada de `CATALOGOS.get(path).length` — para que uma
   troca compensatória entre dois catálogos (um ganha o que o outro perde,
   soma preservada) não passe despercebida. As duas contagens (o literal
   `247` e a linha do catálogo em `CONTAGEM_POR_CATALOGO`) precisam de
   atualização junto com o mutante novo.

## Como adicionar uma fatia

1. Criar o(s) arquivo(s) de catálogo de dado puro em `scripts/mutations/` e o
   runner que os consome sobre `harness.ts` (mecânica A) ou seguindo
   `media.ts` (mecânica B). A descoberta de catálogo não é por nome de
   arquivo: é por conteúdo — um `.ts` de primeiro nível de `scripts/mutations/`
   fora da allowlist `NAO_CATALOGO` que casa `CATALOG_EXPORT_PATTERN`
   (`export const <x>Mutants`, `tests/mutations-slices.test.ts:117`) conta
   como catálogo. `NAO_CATALOGO` (`tests/mutations-slices.test.ts:102-116`)
   lista os módulos de `scripts/mutations/` que não são catálogo próprio —
   harness, tipos, agregadores (`media.ts`, `workflow-durability.ts`) e os
   runners que embutem o array (`self-update.ts`, `web-tools.ts`,
   `workflow-audit-live.ts`, `workflow-executor.ts`). Um arquivo novo sem
   `export const ...Mutants` e sem entrada em `NAO_CATALOGO` não é achado
   pelo teste.
2. Adicionar a entrada em `scripts/mutations/slices.json`: `slice`, `script`,
   `catalog`, `srcGlobs`, `focusFiles`. `srcGlobs` aceita duas formas
   (`scripts/github/mutations-matrix.ts:45-58,96-99`, fail-closed — qualquer
   outra forma lança; forma detalhada em "Forma dos `srcGlobs`", acima):
   `src/<dir>/**` por diretório de primeiro nível de `src/` que a fatia
   cobre, ou o literal `src/<arquivo>.ts` para um arquivo de topo (ex.:
   `"src/cli.ts"` em `workflow-audit-live`,
   `scripts/mutations/slices.json:40`). `tests/mutations-slices.test.ts:447-478`
   assevera que todo `edits[].file` de cada catálogo da fatia (normalizado
   para sob `src/`) casa algum `srcGlobs` dessa fatia — exceto os
   `edits[].file` fora de `src/` que estão na allowlist explícita
   `FORA_DE_SRC` (`tests/mutations-slices.test.ts:298-302`, hoje só os três
   arquivos de fixture em `scripts/mutations/fixtures/**`); qualquer outro
   `edits[].file` fora de `src/` e fora de `FORA_DE_SRC` reprova o teste.
3. Adicionar o script em `package.json#scripts` com o mesmo nome de
   `slices.json#script`.
4. Importar o(s) catálogo(s) novo(s) em `tests/mutations-slices.test.ts`
   (mapa `CATALOGOS`) e remover o(s) diretório(s) agora cobertos da lista
   `SEM_FATIA` desse mesmo arquivo.

`tests/mutations-slices.test.ts` prova, a cada corrida: o schema básico de
cada entrada de `slices.json`; que todo catálogo descoberto por conteúdo em
`scripts/mutations/` (item 1 acima) aparece em algum `catalog`; que os
`catalog` do JSON batem, como conjunto, com os treze catálogos importados em
`CATALOGOS`; que todo `script` existe em `package.json#scripts`; que todo
`focusFiles`/`catalog` existe em disco; que `focusFiles` bate com a união de
`focus.file` dos catálogos da fatia (exceto `media`/`workflow-executor`); que
`srcGlobs` cobre todo `edits[].file` dos catálogos da fatia (item 2 acima); a
contagem por catálogo contra a tabela pinada `CONTAGEM_POR_CATALOGO`
(`tests/mutations-slices.test.ts:515-534` — hoje `workflow-durability-guard`
14, `workflow-durability-named` 41, `orchestration` 5,
`workflow-audit-live-mutants` 32, `workflow-audit-producers-mutants` 25,
`web-tools-mutants` 9, `media-catalog-other` 7, `media-catalog-persistence`
13, `self-update-mutants` 8, `workflow-executor-mutants` 45,
`context-window` 15, `auth-mutants` 13, `supervision-mutants` 20, soma 247) e
a soma de 247 contra os treze catálogos importados; e que todo diretório de
primeiro nível de `src/` está coberto por algum `srcGlobs` ou está em
`SEM_FATIA` com um motivo não vazio — nunca os dois, nunca nenhum dos dois.

## Diretórios de `src/` sem fatia hoje

Doze diretórios de primeiro nível de `src/` não têm catálogo de mutação:
`agent`, `config`, `core`, `cron`, `doctor`, `events`, `memory`,
`onboarding`, `pricing`, `serialization`, `server`, `skills` — listados em
`tests/mutations-slices.test.ts` (`SEM_FATIA`), cada um com o motivo "sem
catálogo de mutantes ainda". Os dezessete diretórios cobertos hoje:
`workflow`, `state`, `orchestration` (fatia `workflow-durability`, também
`supervision` para `workflow`/`orchestration`); `cli`, `commands` (também em
`workflow-audit-live` e `self-update`); `media`, `tools` (fatia `media`,
também em `self-update`); `web` (fatia `web-tools`); `self-update`, `mcp`,
`gateway` (fatia `self-update`); `conversation`, `context`, `providers`,
`catalog` (fatia `context-window`, issue #293 — `state` também está em
`srcGlobs` dessa fatia, já coberto por `workflow-durability`); `auth` (fatia
`auth`, issue #354); `transports` (fatia `supervision`, issue #451 —
primeira fatia a cobrir esse diretório).

"Coberto" aqui quer dizer que `srcGlobs` cita o diretório inteiro
(`src/<dir>/**`, forma acima) — a fatia **dispara** para qualquer mudança
nesse diretório — não que todo arquivo dele tem mutante. Nos quatro
diretórios que a fatia `context-window` acrescentou, a cobertura por
mutante é parcial hoje: `conversation` (2 de 9 arquivos mutados —
`compaction.ts`, `runtime.ts`), `context` (1 de 4 — `token-estimate.ts`),
`providers` (1 de 5 — `context-window.ts`) e `catalog` (1 de 5 —
`windows-cache.ts`). `state` (1 arquivo mutado por essa fatia,
`session-repository.ts`) já estava coberto por `srcGlobs` da fatia
`workflow-durability` antes de `context-window` existir, então não conta
como cobertura nova.

## CI (`mutations.yml`, issue #156)

`.github/workflows/mutations.yml` está em `main` desde a PR #188: dispara em
`pull_request` quando o diff toca `src/**`, `scripts/mutations/**` ou o
próprio workflow — uma PR só de docs não dispara nada. O job `plan`
(`scripts/github/mutations-matrix.ts`) lê `slices.json#srcGlobs` e o diff
`base...head` para decidir quais fatias rodam, e escreve a matriz num
`GITHUB_STEP_SUMMARY`; `mutate` roda uma fatia por job da matriz (`npm run
<script>`) e sobe `.mutation-evidence/` como artifact mesmo em falha (`if:
always()`, `if-no-files-found: warn`).

Não é required no ruleset — decisão do owner, pendente, depois de medir o
tempo por fatia (comentário de topo de `mutations.yml`). Tempos medidos no
Actions (run 34175933045): `workflow-executor` 1 min 28 s,
`workflow-durability` 2 min 16 s, `workflow-audit-live` 2 min 15 s, em
paralelo — parede (do início do `plan` ao fim do último `mutate`) ≈ 2 min 42
s. Até o owner decidir tornar required, o gate de mutação completo (`npm run
mutations:all`) roda localmente, e o passo 11 de `orquestracao.md` (QA em
merge de risco) é quem o exercita.
