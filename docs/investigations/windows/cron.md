# W6 — cron, locks e falhas do agendador no Windows

Investigação da issue [#706](https://github.com/marcelusfernandes/lohra-ts/issues/706),
em 2026-10-02, no commit
`fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`. A medição nativa usou
Windows 11 Pro x64 com Node 20.20.2 e 22.23.3 oficiais portáteis. O controle
Linux usou Node 22.23.3 como usuário não-root no container local, com o mesmo
HEAD e hashes idênticos de `dist/cron/scheduler.js` e `dist/cron/store.js`.
Todos os jobs usaram callback local, sem provedor real. Cron usa o diretório
`jobs.json.lock` para proteger leituras e gravações curtas do JSON; não há
lease SQLite no caminho medido.

## Método e isolamento

As sondas ficaram fora do checkout em `<TEMP>/lohra-w706-20261002`, com
`LOHRA_HOME`, `CODEX_HOME`, `HOME` e `USERPROFILE` temporários. Um guard de
`GetFullPath` exigiu que cada diretório de cenário estivesse sob essa raiz
antes da criação. Dois processos Node independentes compartilharam somente o
mesmo `CronStore` temporário e uma barreira `go`; cada callback gravou PID e
timestamp, esperou 500 ms e só então deixou `tick` marcar `last_run_at`. O
relógio de elegibilidade foi fixado em 100 segundos. Para o crash, um filho
criou o lock, enviou `READY` e ficou vivo até o processo pai encerrá-lo com
`SIGKILL`; somente esse PID e o lock temporário foram manipulados.

Uma primeira execução exploratória foi **descartada por isolamento incorreto**
na variável de caminho do cenário. Seu estado foi revertido e sua saída não
compõe nenhum resultado abaixo. A rodada válida foi iniciada em uma raiz
temporária nova, com guard de caminho e variáveis sem colisão com o shell.

Comandos, saída curta e a fonte exata da sonda temporária estão em
[procedure.md](evidence/cron/procedure.md),
[windows.txt](evidence/cron/windows.txt),
[linux-control.txt](evidence/cron/linux-control.txt) e
[tests.txt](evidence/cron/tests.txt).

## Matriz de resultados

| Cenário                                    | Windows Node 20                             | Windows Node 22                   | Controle Linux Node 22            | Conclusão                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------- | --------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job `once` devido, callback conclui        | `ok:true`, `last_run_at=100`, exit 0        | Mesmo resultado                   | Não medido                        | **PASSED** no Windows                                                                                                                             |
| Callback lança `STUB_SENTINEL`             | `ok:false`, `last_run_at=100`, exit 0       | Mesmo resultado                   | Mesmo resultado, exit 0           | **FAILED para visibilidade da causa**, geral: `tick` não expõe a exceção ao diagnóstico; marcar `last_run_at` na falha é comportamento deliberado |
| Dois schedulers em processos independentes | 2 execuções, 2 PIDs, ambos exit 0           | Mesmo resultado                   | Mesmo resultado                   | **FAILED para execução única**, reproduzido em Linux; o lock cobre operações do store, não a execução do job                                      |
| Filho termina segurando `jobs.json.lock`   | timeout 10.024 s, lock permaneceu           | timeout 10.031 s, lock permaneceu | timeout 10.003 s, lock permaneceu | **FAILED para recuperação automática**, geral; a leitura voltou somente após remoção manual do lock isolado                                       |
| Stop após primeiro tick do loop            | 1 callback, 1 espera, retorno normal        | Mesmo resultado                   | Não medido                        | **PASSED** para shutdown cooperativo do loop de teste                                                                                             |
| Falha de tick após validação inicial       | loop retorna normalmente, diagnóstico vazio | Mesmo resultado                   | Não medido                        | **FAILED para observabilidade**, caso com store stub; o catch do loop não emite causa                                                             |

O resultado do callback que falha aparece como `ok:false` apenas no retorno de
`tick` usado pela sonda. `CronTool` em `list` expõe `last_run_at`, mas não o
status ou a causa; a CLI `cron list` observada no Windows retornou apenas ID,
estado, nome e agenda, exit 0. O `runSchedulerLoop` do dashboard ignora os
`TickResult[]`, e seu `runJob` chama o transporte do modelo. Portanto esta
investigação **não executou dois processos dashboard com provedor**; mediu
dois processos reais com o mesmo scheduler/store e callback stub, a fronteira
onde a duplicidade acontece. A visibilidade de erro na UI do dashboard é
**NOT_MEASURED**; a ausência de causa nas superfícies de cron medidas e no
catch do loop foi reproduzida.

O lock órfão não expirou por idade: a espera de 10 s terminou em
`cron store lock timed out`, deixou o diretório de lock presente e não
reexecutou o job. A sonda removeu **somente o lock que seu filho criou** e
confirmou que `store.list()` voltou a funcionar. Isso mede tempo de recusa e
recuperação manual, não um mecanismo automático de recuperação.

## Testes e classificação

`npm test -- --run tests/cron-scheduler.test.ts tests/cron-store.test.ts
tests/commands-cron.test.ts` no Windows Node 20 terminou exit 1: **57 de 58
testes passaram**. A única falha foi `cron-store.test.ts` no caso
`unreadable`: `chmodSync(path, 0o000)` não tornou o arquivo ilegível para
`readJobs` neste Windows. É uma limitação do método POSIX do teste, separada
dos achados de scheduler; não demonstra que arquivos protegidos por ACL sejam
tratados corretamente. A suíte nativa inteira foi medida na frente #702;
esta issue não a repetiu.

A duplicidade, o descarte da causa e o lock órfão ocorreram no controle Linux
com o mesmo código compilado; não são falhas exclusivas de Windows. Próximas
issues de produto devem tratar reivindicação atômica de jobs, política de
recuperação de lock e diagnóstico de erro do scheduler com testes
cross-process. A validação de ACL Windows precisa de sonda própria com ACL
real, não de `chmod 000`. Nenhum código de produção ou teste foi alterado.
