# Procedimento e cadeia de evidências (#752)

SHA medido: `4850b36079620f30f0d51621219f0e5fb4e646d2`. Ambiente: Windows 11 x64 build `10.0.26200`, Node 20.20.2/npm 10.8.2 e Node 22.23.2/npm 10.9.8. Dois clones independentes em `F:/lohra-752/clones/node20` e `node22`; ambos foram criados por `git clone --no-checkout C:/Users/<USER>/Desktop/repositories/lohra-docs-752 <CLONE>` seguido de `git checkout --detach <SHA>`, com HEAD conferido e `git status --short` vazio. O caminho pessoal da fonte local foi redigido aqui; não se usou `core.protectNTFS=false` nem junction de `node_modules`. `npm ci` terminou **exit 0** em cada clone com Node/npm da própria ABI.

Antes de cada comando, `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, `npm_config_cache` e `npm_config_prefix` foram apontados a subdiretórios exclusivos em `F:/lohra-752/homes/<NODE>`. O processo `serve` da sonda recebeu ainda `APPDATA` e `LOCALAPPDATA` próprios. Usou `LOHRA_PROVIDER=openai` e `OPENAI_API_KEY=T11-DUMMY-KEY-NO-LIVE-EGRESS` **fictícia**; apenas `GET /v1/models` local foi feito, sem chamada de completion ou provider real. O código do teste existente define uma allowlist própria de ambiente, registrada na fonte do teste.

De cada clone, o focal foi:

```text
<NODE.EXE> node_modules/vitest/vitest.mjs run tests/cli-serve-process.test.ts tests/chat-compaction-events.test.ts --maxWorkers=1 --reporter=json --outputFile=F:/lohra-752/logs/focal-<NODE>.json
```

Node 20 e Node 22: comando **exit 1**, reporter com 2 arquivos, 8 testes, 5 PASS, 3 FAIL. As [projeções Node 20](focused-node20.json) e [22](focused-node22.json) guardam SHA-256 do JSON bruto e log, IDs iguais aos do #751, mensagem primária sem stack/caminho pessoal, zero mensagens secundárias e conciliação das contagens. Não houve erro de setup/coleta registrado pelo focal. Os JSONs brutos e logs ficaram em `F:/lohra-752/logs`.

A sonda externa, cuja [fonte integral](source.md) foi preservada, foi executada com cwd do clone correspondente:

```text
<NODE.EXE> F:/lohra-752/serve-probe.mjs <CLONE> F:/lohra-752/homes/serve<NODE>
<NODE.EXE> F:/lohra-752/pack-evidence.mjs F:/lohra-752/logs docs/investigations/windows/evidence/failure-triage/runtime
```

Node 20 e Node 22: `serve-probe.mjs` **exit 0 diagnóstico**, resultados [20](serve-node20.json) e [22](serve-node22.json). Ela abre porta efêmera em loopback, espera prontidão por no máximo 10 s, faz GET com timeout de 2 s, envia `child.kill('SIGINT')`, espera close até 8 s, verifica que a porta pode ser vinculada e encerra apenas seu próprio filho se necessário. O stdout estruturado limita-se a campos booleanos, status HTTP e status/sinal do filho; o stderr do servidor é guardado somente em memória com limite de 16 KiB e usado para conferir presença/ausência de avisos, sem ser publicado. A sonda não usa `process.exit()` para forçar sucesso. O projetor também terminou **exit 0** e falha se as contagens do focal divergirem do reporter.

Uma [checagem pós-ensaio](post-run-check.json) registrou HEAD exato e Git limpo nos dois clones, sem processo remanescente cuja `CommandLine` contivesse um dos clones ou a sonda (excluído o próprio processo de inspeção). Ela não examinou nem encerrou processos alheios. Buscas nos JSONs publicados por raízes pessoais, letras de drive, padrões de token e chaves não encontraram correspondência. Seus `rawReporterSha256`/`rawLogSha256` permitem conferir os brutos externos, que não entram no Git. A fonte da sonda contém apenas a chave fictícia identificada acima. Provider live, egress de completion e handler gracioso via `child.kill` não foram medidos. A evidência independente de Ctrl-C entregue por ConPTY está em [#730](../../../shutdown-validation.md) e não foi fundida a estes exits.
