# Evidência da triagem #753

O inventário de origem é `../inventory/failures-node20.jsonl` e `failures-node22.jsonl`, SHA `ebeb722f898bdb4cde5b7d7cef66fb40febf5c15`. [`mapping.json`](mapping.json) agrupa IDs estáveis sem apagar as mensagens primárias/secundárias do inventário. As sondas rodam no `main` `4850b36079620f30f0d51621219f0e5fb4e646d2`, Windows 11 x64, e não alteram `src/**` ou `tests/**`.

## Preparo

Foram criados dois clones Git independentes, `F:\lohra-m25-753\node20-repo` e `node22-repo`, a partir de `<REPO>` por `git clone --no-local <REPO> <clone>`. Ambos resolveram `git rev-parse HEAD` para `4850b36079620f30f0d51621219f0e5fb4e646d2`, com `git status --short` vazio antes/depois. Cada clone executou `npm ci --no-audit --no-fund` (exit 0) com seu Node/npm e ABI próprios:

| Clone  | Node                                                      | npm CLI                                                                                   | `npm ci`            | Addon                               |
| ------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------- | ----------------------------------- |
| node20 | `F:\lohra-m25-761-runtime\node-v20.20.2-win-x64\node.exe` | `F:\lohra-m25-761-runtime\node-v20.20.2-win-x64\node_modules\npm\bin\npm-cli.js` (10.8.2) | exit 0, 177 pacotes | `better-sqlite3` carregado na sonda |
| node22 | `C:\Program Files\nodejs\node.exe`                        | `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js` (10.9.8)                        | exit 0, 177 pacotes | `better-sqlite3` carregado na sonda |

Antes de `npm ci`, `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, `APPDATA`, `LOCALAPPDATA`, `NPM_CONFIG_CACHE` e `NPM_CONFIG_PREFIX` apontaram exclusivamente para `F:\lohra-m25-753\isolation-nodeXX\...`. A invocação foi `& <node.exe> <npm-cli.js> ci --no-audit --no-fund` dentro do clone da ABI correspondente. Nenhuma credencial, provider ou home pessoal foi lido. Os scripts [`run-probes.ps1`](run-probes.ps1) e [`run-focused.ps1`](run-focused.ps1) aplicam o mesmo isolamento a suas execuções.

## Comandos e resultados

Os comandos finais abaixo têm root **novo** e exclusivo por Node. O runner recusa root preexistente ou fora de `F:\lohra-m25-753`, cria a marca de propriedade, executa cada cenário uma vez e preserva todos os casos; não remove diretórios nem PIDs de terceiros.

```powershell
$runner = 'docs\investigations\windows\evidence\failure-triage\platform\run-probes.ps1'
& $runner -Label node20 -NodeExe 'F:\lohra-m25-761-runtime\node-v20.20.2-win-x64\node.exe' -Clone 'F:\lohra-m25-753\node20-repo' -ProbeRoot 'F:\lohra-m25-753\run-node20-redacted'
& $runner -Label node22 -NodeExe 'C:\Program Files\nodejs\node.exe' -Clone 'F:\lohra-m25-753\node22-repo' -ProbeRoot 'F:\lohra-m25-753\run-node22-redacted'
```

Os dois runners saíram **0**, com quatro cenários cada: `permission`, `signal-int`, `signal-term`, `sqlite`. O `exitCode:0` de cada cenário significa que a sonda completou e registrou seu observado; `EPERM` e `EBUSY` dentro do JSON são as falhas de operação esperadas. [`results-node20.json`](results-node20.json) e [`results-node22.json`](results-node22.json) guardam versões, SHA e resultados sem caminho pessoal/SID. [`probe.mjs`](probe.mjs) é a fonte integral, com limite de quatro segundos e eventual kill **somente** do próprio filho. A sonda SQLite faz exatamente uma remoção no estado aberto e outra depois de fechar; não há retry de `EBUSY`.

Para distinguir descritor de atributo read-only, [`acl-readonly.ps1`](acl-readonly.ps1) leu novamente **apenas** `dummy.txt` criado por cada sonda. O script usa APIs .NET de leitura, classifica ACEs por grupos conhecidos e substitui qualquer outra identidade por `OTHER`; nunca imprime SID, nome, SDDL ou caminho. [`acl-node20.json`](acl-node20.json) e [`acl-node22.json`](acl-node22.json) preservam classe de principal, Allow/Deny, direitos e herança. Os hashes transitórios dos descritores foram comparados dentro da sonda, mas seus valores não foram publicados. Nem ACL nem identidade foram modificadas.

Os testes existentes direcionados foram executados em clones próprios com os comandos de [`run-focused.ps1`](run-focused.ps1):

```text
node <clone>/node_modules/vitest/vitest.mjs run <arquivos-do-grupo> --maxWorkers=1 --reporter=json --outputFile=<F:/lohra-m25-753/focus-nodeXX-valid/grupo-vitest.json>
```

`permission` seleciona `tests/auth-core.test.ts` e `tests/media-persistence.test.ts`; `signal` seleciona `tests/mutations-all.test.ts` e `tests/cli-serve-process.test.ts`; `sqlite` seleciona `tests/gateway/session-service.test.ts`. Todos saíram **1**, sem skip inventado. Os seis reporters e logs brutos permanecem fora do Git em `F:\lohra-m25-753\focus-nodeXX-valid`; [`focused-node20.json`](focused-node20.json), [`focused-node22.json`](focused-node22.json) e [`focused-raw-hashes.json`](focused-raw-hashes.json) dão exit, contagens e SHA-256 dos brutos. Os números focais não substituem a suíte inteira #751.

Uma primeira tentativa dos focais, sob `focus-node20`, chamou Vitest fora do cwd do clone e falhou antes da coleta (`vitest/config` ausente); a fonte do runner passou a entrar no clone e somente `focus-nodeXX-valid` compõe as contagens. Uma primeira leitura de ACL via `Get-Acl` sob home isolada não carregou o módulo PowerShell; a versão válida usa somente APIs .NET. As tentativas inválidas foram preservadas em F: para diagnóstico, sem contaminar os resultados publicados.
