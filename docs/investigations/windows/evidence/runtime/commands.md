# W4 — invocações e evidência reproduzível

Baseline `fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`, Windows 11 x64. Execuções separadas em `clone-workaround` (Node 20) e `clone-workaround-22` (Node 22), sob `%LOCALAPPDATA%\Temp\lohra-w701`. Dependências e `dist` construídos nesses clones temporários. Sonda `probe.mjs` e estados ficaram fora do checkout, sob `%LOCALAPPDATA%\Temp\lohra-w704-<id>`. Ela não é um harness permanente do projeto. As projeções sem tokens e caminhos pessoais são [smoke-node20.json](smoke-node20.json) e [smoke-node22.json](smoke-node22.json).

## Preparação da sonda

Para cada Node, executar o CLI construído como `& $node $clone\dist\cli.js <args>` com ambiente do processo filho explicitamente limitado a `PATH`, `SystemRoot`, `WINDIR`, `ComSpec`, `PATHEXT`, `PROCESSOR_ARCHITECTURE`, `NODE_ENV=production`, `LOHRA_HOME=<temp>`, `CODEX_HOME=<temp>`, `HOME=<temp>`, `USERPROFILE=<temp>`, `APPDATA=<temp>`, `LOCALAPPDATA=<temp>`, `TEMP=<temp>`, `TMP=<temp>`, `LOHRA_PROVIDER=openrouter`, `LOHRA_PROVIDER_BASE_URL=http://127.0.0.1:<stub-port>/v1` e `OPENROUTER_API_KEY=LOCAL-STUB-ONLY`. Nenhuma variável de chave herdada foi repassada. Criar arquivo temporário com conteúdo `W4-FILE` e stub local `node:http` em porta livre, cujo `/v1/chat/completions`:

- em prompt `W4_TOOL`, retorna `tool_calls` de `read_file` para esse arquivo; depois retorna `STUB-FINAL`;
- quando o system prompt da requisição de compactação contém `You are compacting a long conversation`, retorna a síntese curta `COMPACT-SUMMARY`; para os dez turnos de preenchimento, a sonda envia um prompt longo determinístico;
- em prompt `W4_HOLD`, conserva a resposta streaming em aberto até interrupção; para turnos normais responde `STUB-FINAL`, inclusive SSE com `data: ...` e `data: [DONE]` quando solicitado.

Os comandos do CLI usados pela sonda, para **cada** `$node`/`$clone`, foram:

```powershell
& $node "$clone\dist\cli.js" --version
& $node "$clone\dist\cli.js" doctor --json
& $node "$clone\dist\cli.js" chat --json --provider openrouter --model openai/gpt-4o-mini W4_TOOL
& $node "$clone\dist\cli.js" chat --json --no-tools --provider openrouter --model openai/gpt-4o-mini --session '<id obtido da chamada anterior>' W4_RESUME
$env:LOHRA_CONTEXT_WINDOW='17000'
# Após dez turnos de preenchimento na mesma sessão:
& $node "$clone\dist\cli.js" chat --json --no-tools --provider openrouter --model openai/gpt-4o-mini --session '<id>' W4_COMPACT
& $node "$clone\dist\cli.js" dashboard --provider openrouter --model openai/gpt-4o-mini --host 127.0.0.1 --port '<porta livre>' --no-open
```

O dashboard foi sondado via `GET /api/status` sem/com token e WS com token inválido; em WS válido, `session.create`, `prompt.submit`, `session.interrupt` por outro socket, seguido de novo `prompt.submit`. Foram registrados os tipos de frames e status, não o token. As flags constam de `src/cli/arg-spec.ts`. `LOHRA_CONTEXT_WINDOW=17000` foi aplicado ao processo filho; o primeiro ensaio com 13000 gerou resumo mas falhou no limite posterior, por isso não é o resultado válido da compactação.

Para `serve`, confirmar previamente que `127.0.0.1:11434` está livre; iniciar stub nessa porta apenas então. Trocar no ambiente do filho `LOHRA_PROVIDER=ollama`, `OLLAMA_API_KEY=LOCAL-STUB-ONLY` e retirar `LOHRA_PROVIDER_BASE_URL` (esse comando usa a URL fixa do perfil Ollama). Não iniciar se 11434 estiver ocupada:

```powershell
& $node "$clone\dist\cli.js" serve --host 127.0.0.1 --port '<porta livre>' --insecure
# GET /health; GET /v1/models; POST /v1/chat/completions; POST /v1/responses
& $node "$clone\dist\cli.js" serve --host 127.0.0.1 --port '<porta ocupada por socket local da sonda>' --insecure
```

O primeiro `serve` ficou em execução durante as quatro chamadas HTTP e foi encerrado pela sonda com `child.kill('SIGTERM')`. Outra invocação, sobre uma porta diferente mantida ocupada por um socket local da sonda, saiu 2. O dashboard recebeu o mesmo sinal ao final; portas foram testadas para conexão recusada depois do fechamento. No Windows, `child_process` informou `signal=SIGTERM`, `code=null` para ambos, não exit 0 gracioso. Um ensaio inicial de `serve` com perfil OpenRouter tentou um endpoint externo com chave literal fictícia e retornou 502, pois `runServe` não usa o override de base URL. Foi descartado antes da repetição local, e não é evidência de defeito Windows.

## Suíte existente direcionada

Comando executado em **cada clone**, usando seu Node correspondente:

```powershell
& $node .\node_modules\vitest\vitest.mjs run tests/gateway/prompt-submit.test.ts tests/gateway/ws-connection.test.ts tests/gateway/http-server.test.ts tests/cli-serve-process.test.ts tests/conversation-runtime-session.test.ts tests/chat-compaction-events.test.ts
```

| Node    | Exit | Arquivos       | Testes           | Duração |
| ------- | ---: | -------------- | ---------------- | ------: |
| 20.20.2 |    1 | 4 fail, 2 pass | 38 fail, 10 pass |  9.71 s |
| 22.23.3 |    1 | 4 fail, 2 pass | 38 fail, 10 pass | 10.26 s |

Falhas relevantes vistas no reporter: `EBUSY: resource busy or locked, unlink ...\state.db` em teardown de gateway; `ENOENT: no such file or directory, lstat ...\.lohra` (`src/media/persistence.ts:76`) em parte da compactação; dois testes de compactação receberam exit 1 contra esperado 0; três testes de `cli-serve-process` falharam. O reporter completo não foi guardado, para evitar caminhos pessoais e logs volumosos. Não se atribuiu uma causa comum a todos os casos.
