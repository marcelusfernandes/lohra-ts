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

## O que este documento ainda não cobre

Faixas `stable/context/volatile` do prompt, doutrina de relato e escopo,
bloco de harness por superfície, moldura de conteúdo externo, prompt do
subagente, `prompt caching` — nenhum desses existe no runtime hoje. Cada
sub-issue do épico #575 que os implementa atualiza este arquivo quando
mergeia.
