# Eval de comportamento

Harness sobre o stub (`scripts/eval/`) que mede uma mudança de prompt em vez
de opinar sobre ela (issue #576, épico #575). Dois oráculos, deliberadamente
separados:

- **Mecanismo** (determinístico, roda em `npm test` como suíte normal, via
  `tests/eval-cases.test.ts`): o modelo é 100% scriptado (`chat-lane-script`
  do stub) — a pergunta nunca é "a resposta foi boa", é "a requisição/o
  envelope têm a forma que o mecanismo promete" (o system prompt contém X; N
  tool calls por requisição; a ordem de mensagens é Y; o campo Z do envelope
  é W).
- **Resultado** (fora do gate, com provedor real): o mesmo runner com
  `--provider <p>` roda contra um provedor de verdade e julga a resposta
  final contra `outcome.expect` — aqui sim a saída varia.

## Formato de um caso

`tests/fixtures/eval/<id>.json` (o nome do arquivo, sem `.json`, é o `id`):

```json
{
  "input": "prompt do usuário",
  "cwd_fixture": { "path": "arquivo.txt", "content": "conteúdo lido/escrito por uma tool" },
  "stub_script": {
    "default": [
      { "kind": "text", "content": "resposta final" },
      {
        "kind": "tool_calls",
        "calls": [{ "name": "read_file", "argumentsRaw": "{\"path\":\"x\"}" }]
      },
      { "kind": "http_error", "status": 500, "message": "..." }
    ]
  },
  "mechanism": [{ "kind": "request_count", "count": 1 }],
  "outcome": { "question": "pergunta binária para o julgador", "expect": "regex sobre a saída" },
  "budget_tokens": 1000,
  "note": "opcional: coordenação com outra issue do épico"
}
```

`stub_script` é o mesmo formato de `StubLaneStep` que
`tests/parity/stub-lane-script.test.ts` já exercita (fixture
`chat-lane-script` do stub, `scripts/stub/server.ts`): uma lane por nome,
`"default"` quando o prompt não traz um marcador `SCEN:<lane>`. Uma
`delegate_task`/`spawn_session` scriptada no prompt de uma tarefa com
`SCEN:child ...` faz o filho cair na lane `child`, sobre o MESMO stub — é
assim que `child-task-fails-silently.json` reproduz o achado E1 do épico
(um filho com `error_kind: "dead_turn"`, `src/orchestration/child-runner.ts:244`,
enquanto o pai segue `completed: true`/`error: null`) sem nenhuma
infraestrutura nova. `content: ""` num passo `text` é um valor válido (turno
"morto"), não ausência de campo.

`cwd_fixture` escreve um arquivo no diretório de trabalho do CLI antes do
spawn — é o proxy usado para "conteúdo externo" (`web_fetch` de verdade
faria rede, fora do modo stub) e para "informação já no repositório"
(`AGENTS.md`/`CLAUDE.md` na raiz do `LOHRA_HOME` isolado do caso).

### Assertions de `mechanism` (`scripts/eval/oracles.ts`)

| `kind`                     | verifica                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system_prompt_includes`   | substring no `content` do `role: "system"` da N-ésima requisição (`request`, opcional, padrão 1)                                                                             |
| `system_prompt_excludes`   | o mesmo, negado                                                                                                                                                              |
| `request_count`            | nº de `POST /v1/chat/completions` capturadas (pai + filho, se houver)                                                                                                        |
| `message_roles_at_request` | sequência exata de `role` da N-ésima requisição                                                                                                                              |
| `tool_result_includes`     | substring na última mensagem `role: "tool"` da N-ésima requisição                                                                                                            |
| `message_content_includes` | substring em QUALQUER mensagem (`content`, se string) da N-ésima requisição — usado quando o texto pode estar numa mensagem `assistant`/`user` de resumo, não só no `system` |
| `tools_include`/`_exclude` | nome presente/ausente em `body.tools[].function.name` da N-ésima requisição                                                                                                  |
| `envelope_pointer`         | JSON Pointer sobre o envelope final (`value` omitido == espera ausência)                                                                                                     |

`request` é 1-indexado sobre `POST /v1/chat/completions` capturadas (a mesma
contagem de `request_count`) — a requisição 1 de um caso que força
compactação (`context_window_override`) é a do sumarizador, não o turno
"visível" do usuário; veja `session_seed`/`context_window_override` abaixo.

Cada `kind` novo entra em `types.ts` (união fechada), `case.ts` (parsing) e
`oracles.ts` (avaliação) — `parseEvalCase` recusa um `kind` desconhecido, não
o ignora.

### `session_seed` e `context_window_override`: forçando compactação de verdade

Um caso pode declarar:

```json
{
  "session_seed": [{ "user": "...", "assistant": "..." }],
  "context_window_override": 25000
}
```

`session_seed` grava turnos direto em `state.db` via
`SessionRepository.recordTurn` (mesmo padrão de
`tests/chat-compaction-events.test.ts`) **antes** do turno real da
invocação — necessário porque `preflightCompact`
(`src/conversation/runtime.ts`) só encontra história para dobrar quando já
existem turnos PERSISTIDOS de uma sessão anterior; o turno do próprio
`input` do caso nunca tem nada seu para compactar.
`context_window_override` vira `LOHRA_CONTEXT_WINDOW` no ambiente do
processo — pequeno o bastante para os turnos seedados forçarem uma
compactação real, grande o bastante para o piso de tokens de hoje (system
prompt + catálogo de tools + a cauda mantida + o resumo) caber depois de
compactar. Esse piso **muda toda vez que o system prompt ou o catálogo de
tools mudam de tamanho** (ex.: #585/#598 encolheu o catálogo de ~18,3k para
~9,1k tokens estimados, `docs/system-prompt.md`) — um caso que usa esses
dois campos precisa recalibrar o número depois de qualquer mudança desse
tipo; o `note` do fixture documenta o cálculo feito (ver
`compacting-conversation-preserves-prohibition.json`).

Como calibrar: rode o caso, leia o erro
(`ContextWindowExceededError`, `src/conversation/errors.ts`) ou o envelope —
`compaction.estimate_before`/`estimate_after` (quando a compactação roda)
mostram os dois números reais; o `threshold` é
`window * 0.92 - defaultMaxTokens do provedor` (0,92 = `1 - BASE_RESERVE_RATIO`,
`src/conversation/compaction.ts`; `defaultMaxTokens` do `ollama` é 8192,
`src/providers/registry.ts:220`) — escolha uma janela cujo `threshold` caia
entre `estimate_after` (compactação precisa bastar) e `estimate_before`
(compactação precisa ser necessária, senão o turno passa direto sem
compactar e `request_count` fica 1, não 2).

## Split dev/holdout

`tests/fixtures/eval/split.json`: `{ dev: string[], holdout: string[] }`,
disjuntos, cobrindo exatamente os arquivos em `tests/fixtures/eval/*.json`
(menos `split.json`). Pelo menos 15 `dev` e 5 `holdout`
(`tests/eval-cases.test.ts` reprova sem isso). **Holdout nunca é usado para
calibrar texto** — só para medir uma mudança depois de decidida pelo `dev`.
Cada categoria do épico (filho falhou, leituras paralelas, comando negado,
conteúdo externo, preferência do usuário, informação já no repositório,
delegação com escopo, compactação, necessidade de workflow, escolha de
tool) tem pelo menos um caso `dev`; algumas têm um par `dev`/`holdout`.

## Rodando

```bash
npm run eval                        # contra o stub, todos os casos (dev + holdout)
npm run eval -- --set dev           # só dev
npm run eval -- --provider openrouter   # provedor real — nunca em CI
npm run eval -- --cli dist/cli.js   # subprocesso de verdade contra o binário empacotado
npm run eval -- --tag antes-585     # sufixo no diretório de saída, para comparar corridas
```

### Como o CLI é resolvido: `runCli` in-process por padrão, `dist/` é opt-in

Por padrão (sem `--cli`), `scripts/eval/session.ts` chama `runCli`
(`src/cli.js`) **in-process** — importado direto da fonte, o mesmo padrão de
`tests/local-cli.test.ts` — nunca via subprocesso e nunca dependendo de
`dist/cli.js` existir. Isso é deliberado: `npm test` roda ANTES de
`npm run build` no CI (`tests/ci-workflow-order.test.ts`), e
`tests/eval-cases.test.ts` roda o harness inteiro contra o stub como parte
de `npm test` — um teste que exigisse `dist/` reprovaria a coleta inteira
nesse job. `--cli <path>` (tipicamente `--cli dist/cli.js`, depois de
`npm run build`) troca para um subprocesso de verdade contra esse caminho —
o modo do operador para validar o binário empacotado; nunca o caminho que
os testes exercitam.

Sem `--provider`, o ambiente do processo (herdado ou não, dependendo do modo)
é uma allowlist literal apontada para o stub local — nunca há rede possível
(`scripts/eval/session.ts`). Com `--provider`, `run.ts` **e** `runEvalCase`
(defesa em profundidade) recusam rodar quando `CI`/`GITHUB_ACTIONS` estiver
setado com qualquer valor truthy (`scripts/eval/ci-guard.ts`), e o oráculo de
mecanismo é pulado — não há stub interceptando a chamada real para capturar
as requisições cruas; só o oráculo de resultado roda nesse modo.

### `mechanismOk`: tri-estado, nunca um veredito fingido

`mechanismOk` é `true` (todas as assertions passaram), `false` (pelo menos
uma falhou) ou `"skipped"` (modo `--provider`: nenhuma assertion rodou,
porque não existe stub capturando a requisição real para julgar). `"skipped"`
nunca é tratado como passagem — `summary.json` conta os três estados
separadamente (`mechanismPassCount`, `mechanismFailCount`,
`mechanismSkippedCount`), e o filtro de falha do CLI usa `=== false`, nunca
uma checagem de "falsy" que confundiria `"skipped"` com uma falha real. Uma
corrida `--provider` legítima e saudável mostra `mechanismSkippedCount` igual
ao total de casos e `mechanismPassCount: 0` — isso é o esperado, não um sinal
de problema.

Cada corrida grava em `docs/eval/<data>-<stub|provedor>[-<tag>]/`:

- `results.jsonl` — uma linha por caso, **anexada assim que o caso termina**
  (`appendResultLine`); um crash no meio do lote não perde as linhas já
  escritas, e `runCaseSafely` nunca deixa uma sessão que lançou derrubar o
  lote inteiro (vira uma linha de erro, e o lote continua).
- `summary.json` — contagens agregadas e, por caso, tokens medidos
  (`usage_total` do envelope) e se excedeu `budget_tokens`.

### Comparando duas corridas (antes/depois de uma mudança de prompt)

Sem `--tag`, duas corridas no mesmo dia contra o mesmo alvo (`stub` ou o
mesmo `--provider`) truncam o MESMO `docs/eval/<data>-<label>/results.jsonl`
(`resetResultsFile` reseta o arquivo a cada corrida) — a segunda apaga a
primeira. Para medir o efeito de uma mudança que afeta o prompt (system
prompt, catálogo de tools, doutrina de compactação — ex.: a dieta de
#585/PR #598) sobre os MESMOS casos:

```bash
git checkout <SHA-antes> && npm run eval -- --tag antes-585
git checkout <SHA-depois> && npm run eval -- --tag depois-585
```

Isso grava `docs/eval/<data>-stub-antes-585/` e
`docs/eval/<data>-stub-depois-585/` lado a lado. Compare `summary.json`'s
`cases[].totalTokens` por `id` entre os dois — uma queda de tokens sem
mudar `cases[].mechanismOk`/`cases[].outcomeVerdict` é o sinal de que a
dieta economizou sem quebrar comportamento; um caso que virou
`mechanismOk: false` ou mudou de `outcomeVerdict` é uma regressão de
comportamento, não só de custo. Registre o SHA de cada lado na tag ou num
comentário — `summary.json` hoje não carrega o commit da corrida.

## Adicionando um caso

1. Descubra o comportamento real primeiro (spawn manual do stub +
   `dist/cli.js`, como os cases existentes documentam no `note`) — nunca
   adivinhe a forma de uma requisição ou de um resultado de tool.
2. Escreva o fixture com o `stub_script` mínimo que produz esse
   comportamento e as assertions que ficariam vermelhas se ele regredisse.
3. Acrescente o `id` a `dev` (ou `holdout`) em `split.json`.
4. `npm run prova -- eval-comportamento` (roda as duas suítes: unit e contra
   o stub).

## O que muda quando um sub-issue do épico mergeia

Um `note` no próprio fixture aponta a linha que deve mudar. Casos já
reconciliados com sub-issues mergeadas do épico:

- `dangerous-command-denied.json` casa o envelope pós-#577 (mergeado em
  f59e1885): `error` diz `"command refused by the dangerous-command policy
(<descrição>)"` e um campo `refusal` diz `"final"`
  (`src/tools/terminal.ts:98-101`) — antes disso mergear, o mesmo caso
  casava `"command was not approved by the user"`.
- `compacting-conversation-preserves-prohibition.json` casa o
  `SUMMARY_SYSTEM` pós-#584/#596 (mergeado): a seção "Constraints And
  Prohibitions, Verbatim" instrui preservar toda proibição do usuário
  quotada, nunca parafraseada — antes de mergear, o mesmo caso checava a
  AUSÊNCIA dessa instrução.
- `task-does-not-need-workflow.json` documenta uma expectativa
  **corrigida**: antes de #585/#598 mergear, o note previa que
  `tools_include: "run_workflow"` viraria `tools_exclude` numa tarefa
  trivial. Não virou — a dieta do catálogo (`docs/system-prompt.md`)
  encolheu só o TEXTO das descriptions (~18,3k → ~9,1k tokens estimados),
  nunca o CONJUNTO de tools enviado; as 29 tools continuam sempre
  presentes. `tools_include` continua a assertion correta.

`skill-use-lohra-ts-one-leaf.json` cobre o acréscimo do orquestrador vindo
de #590 (mergeado em 449a8a98): uma tarefa autocontida, do jeito que
`assets/skills/use-lohra-ts/SKILL.md` instrui compor, completa com um único
`delegate_task` (uma folha). `use-lohra-ts` é exportada para OUTRO harness
invocar `lohra-ts` via CLI (`src/skills/export.ts`) — não é builtin desta
runtime (só `workflow-authoring` é, `src/commands/chat.ts:295`) — então o
mecanismo trava a forma do script (um `delegate_task`, uma resposta) e os
três critérios de "Verify the delegation" da própria skill (`/error` nulo,
`/completed` verdadeiro, pelo menos um `tool_calls`), não uma prova de que
`skill_view("workflow-authoring")` foi evitado: não existe hoje uma
assertion de "tool não chamado com este argumento" (só `tools_include`/
`_exclude`, que mira o catálogo, não uma chamada específica).

`tool-choice-read-file-over-terminal.json` cobre o acréscimo do
orquestrador vindo de #585: ler um arquivo conhecido deve chamar
`read_file`, não `terminal cat`. O stub é scriptado (sempre devolve a
chamada que escrevemos no fixture), então o oráculo de mecanismo não mede
"o modelo escolheu certo" — mede a FORMA que só uma escolha real produz:
`tools_include` confirma que as duas tools (`read_file` e `terminal`)
estavam de fato oferecidas (a escolha não foi forçada pela ausência de uma
delas no catálogo), e `tool_result_includes` pina o envelope de sucesso do
`read_file` (`"path":...`, `src/tools/filesystem.ts`) — uma chamada de
`terminal cat` teria produzido `stdout`/`exit_code` em vez disso. Só o
oráculo de resultado (`--provider`) mede se um modelo real prefere
`read_file`.

## Fora de escopo (issue #576)

Julgador LLM automático do oráculo de resultado; mudar qualquer prompt;
mutation testing do runner.
