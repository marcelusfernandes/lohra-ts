# Procedimento de #751

SHA medido: `ebeb722f898bdb4cde5b7d7cef66fb40febf5c15` em dois clones Git independentes no Windows 11 x64 (`10.0.26200`). Git `2.47.1.windows.1`; Node 20.20.2/npm 10.8.2 e Node 22.23.2/npm 10.9.8. O comando de preparação e a fonte integral do runner, do sanitizador e do empacotador estão em [source.md](source.md). O código desta PR documental tem SHA próprio e **não** foi o SHA da medição.

Em PowerShell 7, após fixar o SHA:

```powershell
pwsh -NoProfile -File F:\lohra-751-harness\run-inventory.ps1 -Sha ebeb722f898bdb4cde5b7d7cef66fb40febf5c15
```

Para cada Node, o runner executou `git clone --no-checkout https://github.com/marcelusfernandes/lohra-ts.git`, `git checkout --detach <SHA>`, conferiu HEAD e árvore limpa, fez `npm ci` sob a ABI correspondente e então `node.exe npm-cli.js test -- --maxWorkers=4 --reporter=json --outputFile=<TEMP>/vitest.raw.json`. Nenhum clone recebeu `core.protectNTFS=false`; `core.protectNTFS` não estava explicitamente configurado. `core.autocrlf=true` veio da configuração de sistema do Git e foi registrado sem alteração global. `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, cache e prefixo npm foram separados por Node em F:. Não houve provider real nem leitura do home Lohra pessoal.

Os limites foram 10 minutos para clone/checkout, 15 para `npm ci` e 20 para suíte. O runner registra saída, duração, PID, timeout, estado final do processo e SHA-256 de stdout/stderr; em timeout tenta encerrar somente a árvore que criou, registrando erro de término e classificando a etapa como `BLOCKED` se necessário. Nenhum timeout ocorreu no ensaio válido. Logs e JSONs integrais permanecem em `F:/lohra-751-runs/ebeb722f898b-20261011T054223Z`, fora do repositório; [metadata-node20.json](metadata-node20.json) e [metadata-node22.json](metadata-node22.json) guardam hashes para correlacioná-los.

O reporter do Vitest expõe `numTotalTestSuites` e `testResults.length` como grandezas diferentes: aqui 1.153 suites e 336 resultados de arquivo por Node. O sanitizador reconcilia as contagens de assertions (`passed`, `failed`, `pending`, `todo`) com os campos do reporter; status desconhecido ou divergência provoca exit 2. Cada registro de falha tem ID estável SHA-256 curto de `arquivo + teste`, mensagem primária, assinatura da mensagem normalizada e mensagens secundárias em ordem. As 17 mensagens secundárias de cada Node **não** são novos testes falhos. Arquivos, falhas, comparação e diagnóstico stderr foram empacotados em JSONL para auditoria por linha.

O JSON bruto não contém a propriedade `unhandledErrors`: isto é `NOT_REPORTED`, não demonstra zero erros assíncronos. Os sete avisos de stderr por Node estão em `stderr-node*.jsonl` como diagnósticos sem associação a teste; não foram somados a assertions. Os `fileDiagnostics`/erros de coleta sem assertions foram zero neste reporter. Todas as mensagens publicadas passaram por redação de caminhos absolutos, raízes pessoais e padrões de credencial, seguida de busca por drives e revisão das amostras. `fileOperation` preserva `unlink state.db` e `rmdir lohra-eval-session-test-<RANDOM>` nas mensagens secundárias sem expor a raiz temporária.

Antes do ensaio válido, duas tentativas do próprio helper terminaram **antes de `npm ci` e da suíte** porque `Get-Content -Raw` retornou nulo para o arquivo vazio de `git status` e `.Trim()` lançou. A fonte foi corrigida para `File.ReadAllText`; esses diretórios preparatórios foram preservados em F e **não** entram nas contagens deste inventário. O projetor também foi ajustado depois da medição para conservar todos os `failureMessages` e normalizar caminhos escapados. Ambas as projeções foram regeneradas dos mesmos JSONs brutos, sem rerun da suíte.
