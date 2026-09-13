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

| `kind`                     | verifica                                                                    |
| -------------------------- | --------------------------------------------------------------------------- |
| `system_prompt_includes`   | substring no `content` do primeiro `role: "system"` (1ª requisição)         |
| `system_prompt_excludes`   | o mesmo, negado                                                             |
| `request_count`            | nº de `POST /v1/chat/completions` capturadas (pai + filho, se houver)       |
| `message_roles_at_request` | sequência exata de `role` da N-ésima requisição                             |
| `tool_result_includes`     | substring na última mensagem `role: "tool"` da N-ésima requisição           |
| `tools_include`/`_exclude` | nome presente/ausente em `body.tools[].function.name` da N-ésima requisição |
| `envelope_pointer`         | JSON Pointer sobre o envelope final (`value` omitido == espera ausência)    |

Cada `kind` novo entra em `types.ts` (união fechada), `case.ts` (parsing) e
`oracles.ts` (avaliação) — `parseEvalCase` recusa um `kind` desconhecido, não
o ignora.

## Split dev/holdout

`tests/fixtures/eval/split.json`: `{ dev: string[], holdout: string[] }`,
disjuntos, cobrindo exatamente os arquivos em `tests/fixtures/eval/*.json`
(menos `split.json`). Pelo menos 15 `dev` e 5 `holdout`
(`tests/eval-cases.test.ts` reprova sem isso). **Holdout nunca é usado para
calibrar texto** — só para medir uma mudança depois de decidida pelo `dev`.
Cada categoria do épico (filho falhou, leituras paralelas, comando negado,
conteúdo externo, preferência do usuário, informação já no repositório,
delegação com escopo, compactação, necessidade de workflow) tem pelo menos
um caso `dev`; algumas têm um par `dev`/`holdout`.

## Rodando

```bash
npm run eval                        # contra o stub, todos os casos (dev + holdout)
npm run eval -- --set dev           # só dev
npm run eval -- --provider openrouter   # provedor real — nunca em CI
```

Sem `--provider`, o ambiente do processo filho é uma allowlist literal
apontada para o stub local — nunca há rede possível
(`scripts/eval/session.ts`). Com `--provider`, `run.ts` recusa rodar quando
`CI`/`GITHUB_ACTIONS` estiver setado, e o oráculo de mecanismo é pulado
(`mechanismSkippedReason`) — não há stub interceptando a chamada real para
capturar as requisições cruas; só o oráculo de resultado roda nesse modo.

Cada corrida grava em `docs/eval/<data>-<stub|provedor>/`:

- `results.jsonl` — uma linha por caso, **anexada assim que o caso termina**
  (`appendResultLine`); um crash no meio do lote não perde as linhas já
  escritas, e `runCaseSafely` nunca deixa uma sessão que lançou derrubar o
  lote inteiro (vira uma linha de erro, e o lote continua).
- `summary.json` — contagens agregadas e, por caso, tokens medidos
  (`usage_total` do envelope) e se excedeu `budget_tokens`.

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

Um `note` no próprio fixture aponta a linha que deve mudar (ex.:
`dangerous-command-denied.json` casa `"command was not approved by the
user"` até #577 mergear, quando `refusal: "final"` some no lugar — troca de
uma substring). `task-does-not-need-workflow.json` documenta o oposto: hoje
`tools_include: "run_workflow"` é verdade em qualquer tarefa (catálogo
inteiro sempre enviado); depois de #585, essa mesma assertion deve virar
`tools_exclude`.

## Fora de escopo (issue #576)

Julgador LLM automático do oráculo de resultado; mudar qualquer prompt;
mutation testing do runner.
