# Escopo na identidade da célula de cache — irmãos aninhados idênticos

- **Data:** 2026-09-10
- **Origem:** issue #332, apontada pelo implementador da PR #331 (#319) —
  `runCheckpoint` já resolveu o mesmo defeito para checkpoint; este registra a
  mesma decisão para `agent`/`parallel`/`pipeline`/`verify`/`judge_panel`/
  `loop_until_dry`/`gate`/`completeness_check`.

## Contexto

`WorkflowEngine.cell()` (`src/workflow/engine.ts`) hasheia
`...this.specIdentity, ...parts` — e, antes desta issue, `specIdentity`
carregava só `[spec.name, spec.meta.version ?? null]` (`engine.ts:383`),
igual para toda célula do MESMO template, não importa em qual profundidade
ou sob qual nó `workflow` ele foi carregado. Um autor que reusa o mesmo
template aninhado duas vezes no mesmo run — `sub1` e `sub2`, ambos
`{ type: "workflow", ref: "inner" }`, mesmas entradas — faz os dois filhos
carregarem o MESMO `spec.name`, então o segundo produz byte-a-byte a mesma
célula do primeiro para `agent` (`runAgent`, `engine.ts:444`), o grupo de
`parallel` (`runParallel`, `engine.ts:473`) e cada branch individual dele
(`replayOrCollectBranch`/`recordGroupReplayCost`, `engine-utils.ts`, via
`ParallelBranchDeps.spec = this.specIdentity`) — e da mesma forma para
`pipeline.stage`, `verify`, `judge_panel`, `loop_until_dry`, `gate` e
`completeness_check`. `sub2` então reproduz (HIT) a saída de `sub1` com zero
spawns e zero custo próprio: um "cache hit" que na verdade é uma colisão de
escopo, não trabalho legitimamente repetido.

`runCheckpoint` (`engine.ts:977`) já não tinha esse problema: #319 já
chaveava manualmente por `[...this.nodeScope, node.id, "checkpoint", prompt]`
— o próprio nome do campo `nodeScope` (`engine.ts:79`, populado em
`runNested`, `engine.ts:861`, como `[...this.nodeScope, node.id]` a cada
nível de aninhamento) já existia para esse fim, só não alimentava `cell()`.

## Decisão

Opção **(a)**: o escopo entra na identidade da célula — sem dedupe entre
irmãos idênticos. Implementado dobrando `nodeScope` em `specIdentity`
(`engine.ts:383`, `WorkflowEngine.run()`):

```ts
this.specIdentity = Object.freeze([spec.name, spec.meta.version ?? null, ...this.nodeScope]);
```

em vez de uma função `scopedCellParts` aplicada em cada um dos oito
`this.cell([...])` (a sugestão original da issue): como toda célula passa
por `cell()`, que já espalha `...this.specIdentity`, dobrar o escopo ali UMA
VEZ cobre `agent`/`parallel`/`pipeline`/`verify`/`judge_panel`/
`loop_until_dry`/`gate`/`completeness_check` de uma vez — incluindo o cache
POR BRANCH de `parallel` (`ParallelBranchDeps.spec`, que é literalmente
`this.specIdentity` passado por referência), que uma função aplicada só ao
hash de GRUPO em `runParallel` teria deixado de fora. Zero crescimento em
`engine.ts` (988 linhas, igual à base): a mudança são duas linhas de uma
palavra a mais cada (`specIdentity` e a simplificação do checkpoint abaixo).

`runCheckpoint` (`engine.ts:977`) simplifica de
`[...this.nodeScope, node.id, "checkpoint", prompt]` para
`[node.id, "checkpoint", prompt]` — o `nodeScope` que ele prependia à mão
agora vem de `specIdentity`. A sequência de argumentos que chega em
`contentHash` é **idêntica**: `[name, ver, ...nodeScope, node.id,
"checkpoint", prompt]` antes e depois. Fixado por teste (compat de raiz,
abaixo); #319 continua correto e intocado em comportamento.

Na raiz, `nodeScope` é `[]` (`engine.ts:108`) — `...this.nodeScope` no
`specIdentity` é um no-op, então toda célula de raiz gravada por qualquer
banco durável ANTES desta mudança continua hasheando exatamente igual e
continua HIT no resume. Só célula de nó DENTRO de um `workflow` aninhado
muda de hash.

### Por que (a) e não (b)

A issue oferecia (b): manter dedupe, atribuir o custo ao primeiro executor
e marcar o segundo como `replay` explícito. Rejeitada pela mesma razão que
#319 já deu para checkpoint: a saída de `sub2` não é semanticamente a mesma
que a de `sub1` só porque o TEMPLATE e as ENTRADAS coincidem — `causalContext`
e `cellId` (`src/workflow/runtime.ts:7`, `buildCausalContext` em
`engine-utils.ts`) identificam uma EXECUÇÃO, não um template; um `cellId`
compartilhado entre dois nós que o autor do spec claramente pretendeu
distintos (dois nós, dois ids) quebra essa identidade causal mesmo com
atribuição de custo corrigida. (a) mantém "um nó, uma execução, um custo" —
o mesmo invariante que #319 já fixou para checkpoint.

## Consequência para bancos existentes

Um banco durável escrito ANTES desta mudança tem células de `agent`/
`parallel`/... DENTRO de um `workflow` aninhado (`nodeScope` não vazio)
hasheadas sem escopo. No primeiro resume depois do deploy, esses nós
re-executam (miss de cache) — só custo, sem corrupção: a mesma classe de
efeito que as duas mudanças de chave de célula mais recentes já
introduziram e que ficam registradas aqui, juntas, pela primeira vez:

- **Checkpoint** (#319, commit `2a932239`): a chave passou a incluir
  `nodeScope` — células de checkpoint aninhado gravadas antes dessa mudança
  deixam de casar e o run repausa (fail-closed, não silencioso: a resposta
  antiga não é perdida, só precisa ser respondida de novo).
- **`loop_until_dry`** (#238, commit `fc3c875a`): a chave passou a incluir
  `budget` quando o campo está presente — um nó com `budget` gravado ANTES
  dessa mudança re-hasheia e re-executa no resume; sem `budget` o hash
  continua byte-idêntico.
- **Esta issue (#332)**: a chave de toda célula não-checkpoint DENTRO de um
  `workflow` aninhado passou a incluir `nodeScope` — mesma classe de efeito
  (custo, não corrupção), mesmo texto de aviso para quem versiona o motor
  contra um banco em produção com runs pausados aninhados.

## Lacunas registradas, não corrigidas nesta issue

Duas lacunas fora do alcance desta PR — cada uma citada aqui por decisão
explícita, não por omissão:

- **`rename_hint` não documentado** (apontado no veredito da PR #331/#319):
  a chave nova em `pause_payload_json` (`checkpointPausePayload`,
  `engine-utils.ts:743`, só presente em colisão `scoped`) não aparece na
  descrição de `workflow_status` nem do `checkpoint` builtin
  (`src/tools/builtin-definitions.ts:484`, ainda
  `checkpoint{node_id, prompt, default?}`). `builtin-definitions.ts` não
  está nos `Files` desta issue — só registrado; o orquestrador abre issue.
- **`sub[${reference}]:${nodeId}` colide entre irmãos que reusam o mesmo
  `ref`** (`runNested`, `engine.ts`, dentro do bloco que soma custos e
  faults da execução aninhada ao `RunResult` do pai): o prefixo `"sub["` é
  um LITERAL fixo, nunca o id do nó `workflow` que chamou — `sub1` e `sub2`
  escrevem no MESMO `nodeCosts["sub[inner]:a"]`, o segundo sobrescrevendo o
  primeiro, mesmo depois da correção de escopo desta issue (que garante que
  CADA um executa de verdade e tem seu PRÓPRIO custo real internamente).
  Não corrigido aqui porque:
  1. O trecho inteiro (`nullCount` até `forcingFallbacks`) é a âncora de
     mutação `nested-fold-removed`
     (`scripts/mutations/workflow-executor-mutants.ts`) — teria que ser
     preservado byte a byte, e qualquer reformulação que muda o VALOR de
     `reference` também muda o texto fonte ao redor dele.
  2. O formato atual já está fixado por
     `tests/workflow-nodes-tool.test.ts:420-421`
     (`"sub[inner]:leaf"`/`"sub[inner]"`), fora dos `Files` desta issue.

  Efeito prático depois desta PR: `result.outputs.sub1`/`result.outputs.sub2`
  e o custo AGREGADO do run (`result.tokensIn`/`tokensOut`, que fazem
  `+=` simples e não colidem) já refletem a execução real e distinta de
  cada irmão; só a CHAVE do dicionário `nodeCosts` no nível do pai continua
  a nomear os dois da mesma forma, com o valor do último irmão vencendo.

## Doutrina para autores de spec

Reusar o mesmo template (`ref`) em dois nós `workflow` irmãos com entradas
idênticas SEMPRE executa os dois de verdade — nunca reaproveita a saída de
um para o outro, mesmo quando o resultado seria idêntico. Quem quer
deliberadamente uma única execução compartilhada entre dois pontos do DAG
factoriza o node (chama o mesmo `agent`/`parallel` uma vez e referencia a
saída via `${node_id.field}` nos dois lugares), em vez de duplicar o
`workflow` node esperando que o cache dedupe por ele.

## Evidência

- `tests/workflow-parallel-cells.test.ts`, describe `nested siblings reusing
an identical template — cell scope (#332)`: `sub1`/`sub2` com o mesmo
  `ref` (agente e parallel) — dois spawns/quatro spawns reais (não um/dois
  reaproveitados), saída própria por irmão, `tokensIn` agregado reflete os
  dois leaves reais.
- `tests/workflow-parallel-cells.test.ts`, describe `root cell identity is
unchanged by the #332 scope fix — compat`: o hash de uma célula `agent`
  na raiz, calculado pela MESMA fórmula da base (`contentHash(name, null,
"a", "agent", "x", null, null, null)`), continua HIT sem spawn — prova
  direta de que `nodeScope` vazio é no-op.
- As descrições dos testes de `parallel` já existentes neste arquivo (grupo
  e por-branch, ambos calculando o hash de raiz diretamente) não mudaram e
  continuam verdes — compat adicional para o caso `parallel` na raiz.
