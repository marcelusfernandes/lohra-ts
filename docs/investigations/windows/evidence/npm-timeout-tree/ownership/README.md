# #882 — ownership de uma árvore npm no Windows

**Resultado: primitiva viável nesta bancada; integração ainda não demonstrada.** Em Windows 11 x64 (build 26200), Node 20.20.2 e 22.23.2, uma sonda descartável criou `npm → middle.cjs → child.cjs` sob um Job Object próprio. Nos dois Nodes, os dez cenários definidos terminaram com zero violações da sonda. O caso de timeout observou quatro processos ativos antes de `TerminateJobObject` e zero depois; o marcador tardio do filho não apareceu na janela observada, e um controle próprio fora do job concluiu. A ausência do marcador **não é a prova isolada**: ela é combinada com a consulta de `ActiveProcesses`, marcadores de início e resultado do controle.

## Método reproduzível

As fontes desta pasta são a bancada, não código de produção. `run-probe.ps1` prepara, para cada cenário, uma fixture npm própria em um diretório novo. A invocação principal usa `pwsh` 7.6.5 e caminhos absolutos para `node.exe` e `npm-cli.js` da **mesma ABI**. O Node 20 é portátil; o Node 22 é o executável local. Uma execução complementar usou Windows PowerShell 5.1.26100.9444 com Node 22. O runner configura `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, cache/prefixo/configuração npm em diretório isolado antes do primeiro npm, sem ler configuração pessoal e com npm offline. `OutputRoot` precisa ser novo em cada tentativa; os comandos abaixo registram os caminhos executados, que devem ser trocados por diretórios novos na repetição.

```powershell
$source = 'C:/Users/marce/Desktop/repositories/lohra-docs-882/docs/investigations/windows/evidence/npm-timeout-tree/ownership/run-probe.ps1'
$node20 = 'F:/lohra-m25-761-runtime/node-v20.20.2-win-x64'
pwsh -NoProfile -File $source -NodeExe "$node20/node.exe" -NpmCli "$node20/node_modules/npm/bin/npm-cli.js" -OutputRoot 'F:/lohra-m25-882/node20-final5' -IsolationRoot 'F:/lohra-m25-882/isolation-node20-final5' -Tag node20
pwsh -NoProfile -File $source -NodeExe 'C:/Program Files/nodejs/node.exe' -NpmCli 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js' -OutputRoot 'F:/lohra-m25-882/node22-final5' -IsolationRoot 'F:/lohra-m25-882/isolation-node22-final5' -Tag node22
powershell.exe -NoProfile -NonInteractive -File $source -NodeExe 'C:/Program Files/nodejs/node.exe' -NpmCli 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js' -OutputRoot 'F:/lohra-m25-882/node22-ps51-final5' -IsolationRoot 'F:/lohra-m25-882/isolation-node22-ps51-final5' -Tag node22ps51
```

As três execuções saíram com **código 0**. Os JSONs [Node 20](node20-results.json), [Node 22](node22-results.json) e [PowerShell 5.1](node22-ps51-results.json) contêm versões, SHA-256 das cinco fontes, tempos em milissegundos, contadores, códigos Win32 e zero violações; os três `*-console.log` contêm somente marcadores e estados dos cenários. Os hashes são calculados da fonte executada, não de arquivos da fixture copiados. Tentativas anteriores a `final5` foram preservadas fora da evidência final. As primeiras foram descartadas metodologicamente porque o isolamento inicial não cobria `HOME` e todas as configurações npm; nenhuma configuração pessoal foi lida ou reproduzida. Rodadas posteriores também foram substituídas após ajustes na fonte.

| Execução                 | Compile `Add-Type` |  Normal | Timeout | Criação com job na chamada |              Cenários |
| ------------------------ | -----------------: | ------: | ------: | -------------------------: | --------------------: |
| Node 20 / PowerShell 7   |             694 ms | 2174 ms | 1209 ms |                    1869 ms | 10/10, zero violações |
| Node 22 / PowerShell 7   |             690 ms | 2398 ms | 1176 ms |                    1856 ms | 10/10, zero violações |
| Node 22 / PowerShell 5.1 |             299 ms | 2400 ms | 1172 ms |                    1890 ms | 10/10, zero violações |

Tempos abrangem a execução do cenário: o controle normal espera o trabalho tardio programado em 1500 ms; o timeout espera o filho iniciar e o controle externo produzir seu marcador em 1100 ms. **Não medem um deadline de 300 ms de `runNpmSync`.** Só `Add-Type` custou 694/690 ms em PowerShell 7 e 299 ms em PowerShell 5.1; inicialização do shell e criação do processo somam custo adicional. Compilação por chamada não cabe de modo demonstrado no orçamento de 300 ms. As cinco fontes somam ~30 KiB; um helper de produção ainda exigirá protocolo/empacotamento e medição de startup.

## Observações causais

`normal` criou o npm suspenso, atribuiu ao job, constatou marcador ausente antes de `ResumeThread` e deixou intermediário e filho concluir; a contabilidade registrou quatro processos associados. `timeout` esperou o marcador `child-started`, mediu `ActiveProcesses=4`, terminou **o próprio handle do job**, mediu `ActiveProcesses=0` e não viu `child-late` até o fim da janela. O `control.cjs`, lançado por handle próprio fora desse job, produziu seu marcador. `uncontained-control` deixou de atribuir o job, terminou apenas o handle do pai npm da fixture e observou o filho produzir `child-late`; isso confirma que o marcador teria aparecido sem a contenção. O filho escreve argumentos recebidos (`space & value`), cwd e token isolado em arquivo da fixture temporária; o resultado confirma esses valores, mas esses arquivos brutos não são versionados.

`create-failure` obteve erro Win32 **2** para executável inexistente. `assign-failure`, `resume-failure`, `query-failure` e `termination-failure` injetaram apenas handles inválidos próprios e registraram erro Win32 **6** na API correspondente, com cleanup do processo/job próprio e `ActiveProcesses=0`. Nenhum modo escolheu PID por nome, encerrou processo preexistente ou tentou remover diretório como prova de término.

Há ainda um segundo caminho medido: `atomic-normal` usou `PROC_THREAD_ATTRIBUTE_JOB_LIST` em `CreateProcessW` com `CREATE_SUSPENDED`. A consulta feita **logo no retorno da criação, antes de resume**, viu `ActiveProcesses=1` e `IsProcessInJob=true`; após resume, npm/intermediário/filho concluíram, com cinco associações contabilizadas e zero ativas ao final. `atomic-invalid-job` passou um handle inválido no atributo: `CreateProcessW` falhou com código **6**, sem processo suspenso ou marcador. Isso reduz a janela entre criar e atribuir vista no caminho `AssignProcessToJobObject`. Não foi testada morte do helper durante criação, nem se esse atributo está disponível em todos os Windows suportados.

O processo PowerShell já estava dentro de um job neste host (`ParentAlreadyInJob=true`), e a associação adicional funcionou nas três execuções. Isso é **um** caso de job aninhado. Breakaway, políticas de job preexistente distintas, versões antigas do Windows e descendentes criados por mecanismos excepcionais continuam **INCONCLUSIVOS**. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` foi configurado como proteção de cleanup, mas esta bancada mediu término explícito com `TerminateJobObject`, não um experimento separado de fechamento do último handle.

## Limites para #883–#885

1. **#883, helper de ownership:** preferir avaliar `PROC_THREAD_ATTRIBUTE_JOB_LIST` na criação, com falha fechada se não puder associar. O fluxo criar suspenso → atribuir → resume medido também evita execução antes da atribuição, mas deixa uma janela de processo suspenso **fora** do job se o helper morrer antes de `AssignProcessToJobObject`; não há prova de contenção universal nessa janela. Medir compatibilidade do atributo, nested job e breakaway em ambientes-alvo, sem matar por PID reciclável.
2. **#884, transporte síncrono:** definir custo de inicialização fora ou dentro do prazo de 300 ms, protocolo de sucesso/erro e ownership do handle, escape completo de argv Windows, ambiente/cwd explícitos, captura independente de `stdout` e `stderr`, limite de bytes e indicação de truncamento. Aqui o argumento controlado com espaço e `&`, cwd e env funcionaram, e marcadores chegaram ao console; **bytes exatos, interleaving, Unicode, maxBuffer, EPIPE/ENOBUFS, fechamento dos pipes e causas de spawn não foram comprovados**. A escolha de PowerShell 5.1 é tecnicamente executável nesta bancada, mas o custo e a distribuição do helper continuam em aberto.
3. **#885, integração npm:** testar o deadline real de 300 ms e um descendente tardio de fixture sem prometer que timeout mata árvore antes disso; preservar API síncrona, status/signal/error, bytes, cwd/env e limites atuais. A medição #882 encerrou o job somente **depois** de `child-started` e não reproduziu a chamada `runNpmSync`.

O orçamento de implementação de #883–#885 precisa ser reavaliado antes de código: atribuição atômica, serialização de pipes e tratamento de falhas podem superar uma issue S/~2 mil linhas se combinados. Esta investigação não altera suporte declarado de Windows e não testa Linux. No Linux, esta pasta é apenas documentação e não executa as APIs Win32.

## Fontes da plataforma

- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): associação normal de descendentes e exceções de breakaway; limite de fechamento do último handle.
- [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject): associação de processo suspenso e jobs aninhados.
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): `PROC_THREAD_ATTRIBUTE_JOB_LIST` associa handles de job durante a criação; documentado para Windows 10+/Server 2016+.

A inferência de que criar suspenso evita execução antes da atribuição é nossa e foi limitada aos marcadores observados. A medição do atributo de criação está no JSON e no código desta pasta; a documentação da Microsoft não substitui esses resultados locais.
