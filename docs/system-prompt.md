# Custo do prompt de execução

Este documento nasce com a issue #585 (épico #575, P9 — dieta do catálogo de
tools) e cobre só o que essa issue mudou: o piso de tokens que o catálogo de
tools paga em toda chamada. A doutrina do system prompt em si (identidade,
harness por superfície, memória, subagente) é escopo de outras sub-issues do
mesmo épico (#579–#590) e ganha seção própria aqui à medida que mergeiam —
este arquivo não descreve hoje o que ainda não existe no runtime.

## O catálogo de tools é reenviado inteiro a cada iteração

`src/conversation/runtime.ts` manda `BUILTIN_DEFINITIONS`
(`src/tools/builtin-definitions.ts`) completo a cada chamada ao provedor,
dentro do turno — não só na primeira iteração. As 29 tools, schema e ordem
intocados (contrato pinado por hash SHA-256 em
`tests/builtin-definitions-budget.test.ts`), custam:

|                                    | antes da dieta (#585) | depois                             |
| ---------------------------------- | --------------------- | ---------------------------------- |
| chars de JSON do catálogo          | 43.951                | 21.950 (teto de CI: 22.000)        |
| tokens estimados (2,4 chars/token) | ~18.313               | ~9.146                             |
| % em tools de `workflow_*`         | 72%                   | reduzido, mesma proporção de tools |

A regra de conversão (2,4 chars/token) é a mesma que
`src/context/token-estimate.ts` usa para a estimativa de janela de contexto
antes de cada chamada (`docs/context-compaction.md`).

## O que a dieta moveu, e para onde

`run_workflow` sozinha tinha 8.157 chars de description — um manual completo
(exemplo de spec, semântica de pivô de rota, glossário do rollup) que
também vivia, quase palavra por palavra, em
`assets/skills/workflow-authoring/SKILL.md`. A dieta manteve na description
só o que uma tool description deve conter (Claude Code,
`tool-use-concepts.md`: "seja prescritivo sobre quando chamar, não apenas o
que faz"):

- a lista fechada dos 10 tipos de nó (nomes, não a semântica de cada um);
- a doutrina de comportamento que não pode viver só na skill (`lohra`
  Python #36: "texto segura manchetes, não cláusulas sutis") — o
  filesystem compartilhado entre branches de `parallel`, os campos
  `min_success_ratio`/`budget` como tetos reais;
- o ponteiro `Load the workflow-authoring skill before authoring`.

Tudo que é manual — qual node type cabe em qual formato de tarefa, como
dimensionar o fan-out, `live_tail`, `rename_hint`, `workflow_leaf_read`,
`workflow_steer`, o glossário de eventos do `workflow_audit` — saiu das
descriptions das tools `workflow_status`/`workflow_audit`/`workflow_preview`/
`workflow_leaf_read`/`workflow_steer` e ganhou seção própria na skill
(`## Live tail, rename_hint, mid-flight leaf reads, and steering`, mais as
seções pré-existentes de sizing e reading do rollup).

## As sete tools básicas ganharam "quando usar / quando não / limite"

`read_file`, `write_file`, `terminal`, `web_fetch`, `web_search`,
`session_search` e `skill_view` tinham descriptions de 1-2 linhas sem dizer
quando usar, quando não, ou qual o limite de tamanho — por exemplo,
`read_file` não dizia que trunca em 100.000 code points nem que existe
`terminal` como alternativa para um arquivo grande demais. A dieta reescreve
as sete no mesmo padrão: propósito, quando preferir a alternativa (`terminal`
vs. `read_file`/`write_file`, `web_search` vs. `web_fetch`), e o limite
numérico real do código (não um número inventado).

## Overlay de avisos operacionais no turno (issue #589, P13)

Distinto da dieta do catálogo acima (que corta o que é enviado sempre): o
overlay de avisos ACRESCENTA conteúdo à mensagem do usuário, só quando há
algo pendente. `ConversationRuntime.runTurn` recebe uma porta opcional
`notices: TurnNoticesPort` (`src/context/notices-overlay.ts`); sem ela — ou
sem nada pendente — o request é byte-idêntico a antes desta issue existir.

Com avisos pendentes, o que entra no turno:

- No início, um _claim_ lê os avisos não reconhecidos do escopo `global` mais
  `session:<id>` para a sessão e cada ancestral
  (`SessionRepository.lineageRootToTip`) — nunca `run:<id>` (workflow run e
  sessão de chat são namespaces de id disjuntos; detalhe completo em
  `docs/operator-notices.md#entrega-no-turno-sem-tool-call-issue-589`).
- O bloco formatado tem teto de **4.096 chars** (cabeçalho
  `OPERATOR NOTICES (not the user speaking):`, marcador de fim); o que não
  coube fica de fora do texto e do que é reconhecido, pendente para o
  próximo claim.
- Anexado ao CONTEÚDO da mensagem do usuário do turno — nunca ao
  `systemPrompt` (mesma doutrina de P3/P4: bloco do operador não é fala do
  usuário; o cabeçalho reforça isso em texto).
- **Ack só depois de `commitTurn`** gravar o turno; qualquer falha antes
  disso pula para o `catch` de `runTurn`, que nunca confirma — o aviso
  reaparece no claim do próximo turno exatamente como se este nunca tivesse
  rodado.
- Um turno morto publica seu próprio aviso (`session:<sessionId>`, `kind`
  mapeado de `ConversationError.code`) para o PRÓXIMO turno da mesma sessão
  ver, via claim.

Wireado sobre o MESMO `noticesRepository` que `workflow_notices` já lê, em
`chat.ts` e no `runJob` do `dashboard.ts` — nenhuma superfície nova.

## Doutrina de comportamento (issue #579, P3)

`src/context/doctrine.ts` — o que faltava além de `DEFAULT_IDENTITY`
(`src/context/system-prompt.ts:1-5`): relatar o observado, tratar o escopo
pedido como o entregável, agir em vez de narrar opções, e nunca terminar um
turno em plano, pergunta ou promessa. Duas constantes, em inglês como o
resto do prompt:

- **`DOCTRINE_CORE`** (~400 tokens, 2,9 chars/token — a mesma regra de
  conversão de `src/context/token-estimate.ts`) — enviado a TODO perfil de
  provedor.
- **`DOCTRINE_EXTENDED`** (~370 tokens adicionais) — forma e julgamento
  (uma ideia por frase, diagnóstico ≠ conserto, reafirmação do usuário
  encerra o debate, evidência antes de mudar estado). Só perfis "fortes".

Nenhuma das duas descreve um mecanismo do harness que não existe (aprovação
humana de comando, plan mode, canal de pergunta ao usuário, fallback de
modelo) — isso é escopo do bloco Harness por superfície (#580, P4); a
doutrina só referencia o comportamento esperado do MODELO.
`tests/context-doctrine.test.ts` prende as duas coisas: frases de
comportamento presentes, frases de mecanismo inexistente ausentes.

`buildSystemPrompt` (`src/context/system-prompt.ts`) recebe `doctrine` como
uma string já resolvida e a posiciona na faixa `stable`, depois da
identidade e antes de `Environment` — ausente por default, byte-idêntico a
antes de #579 quando nenhuma superfície passa doctrine.

### Tier por perfil: `resolveDoctrineTier`

`resolveDoctrineTier` (`src/context/doctrine.ts`) decide `"core"` ou
`"extended"` por nome de provedor (`profile.name`), com
`LOHRA_DOCTRINE=core|extended` sobrepondo o default — qualquer outro valor
não vazio falha fechado (lança), nunca cai silenciosamente no default.
`ollama` é o único perfil builtin em `"core"` por default: o próprio épico
#575 cita "modelos pequenos via Ollama" como o caso que uma doutrina longa
pode piorar. Todo outro nome (conhecido ou futuro, incluindo
`"openai-codex"`) cai em `"extended"`.

Deliberadamente **não** é um campo em `ProviderProfile`
(`src/providers/types.ts`): esse arquivo ficou fora do escopo de arquivos
desta issue. `resolveDoctrineTier` chaveia por `profile.name`, que já é
público — uma extensão futura da interface (se um perfil precisar de mais
que um nome para decidir a faixa) é decisão de outra issue.

### Fiação por superfície

`chat`, `dashboard` e `serve` resolvem a faixa uma vez (não a cada turno —
invariante 1 do CLAUDE.md: o system prompt é construído uma vez por sessão
e congelado) a partir do `profile` já escolhido, e passam o texto resolvido
para `buildSystemPrompt`. `serve` deixava de mandar só identidade + data;
agora manda a doutrina também.

O subagente (`src/orchestration/subagent-prompt.ts`) recebe sempre
`DOCTRINE_CORE`, nunca a extensão: o call site que o invoca
(`src/orchestration/chat-wiring.ts`'s `buildSubagentPrompt`) não tem o
perfil do provedor pai disponível para decidir a faixa, e essa fiação ficou
fora do escopo de arquivos desta issue — #583 (P7, "prompt do subagente com
ambiente, tools e contrato de retorno") é quem estende esse call site com
mais contexto, e pode herdar a faixa do pai então.

## O que este documento ainda não cobre

Bloco de harness por superfície, moldura de conteúdo externo, contrato de
retorno do subagente, `prompt caching` — nenhum desses existe no runtime
hoje. Cada sub-issue do épico #575 que os implementa atualiza este arquivo
quando mergeia.
