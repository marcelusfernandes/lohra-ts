# Launcher nativo do dashboard — #849

Base `c1dc5596a5fff72219cbfe6d28caec1b5942f275`; vermelho compilável
`a86c9be6cc9956e5e45b295a6532ec588f0be99b`; verde
`f2eb68fd41e13fbbbaad7e87838248f762deedcd`; ajuste de cleanup
`76c82edda05188ec1fe30887bfe77b242b1fe1e9`. Os testes foram
executados em Windows 11 Pro build 26200 com Node 20.20.2 e 22.23.2, em
clones de ABI e homes/cache/TEMP isolados em `F:/lohra-849/`. Nenhum arquivo de produção, helper ou
configuração global foi alterado.

| Contrato     | Vermelho Node 20/22                                                             | Verde Node 20/22                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| argv         | `findIndex` com `/src/cli.ts` retorna -1, mas o entry nativo está na posição 2  | `process.execPath`, `--import`, `import.meta.resolve("tsx")`, entry absoluto via `resolve`, argv completo e uma única chamada `spawn` exatos; wrapper proibido para ambos os separadores |
| REST/WS      | Boot, REST 200/body e WS 101/`gateway.ready` chegam até a última asserção       | Mesmos contratos preservados                                                                                                                                                             |
| encerramento | `child.kill("SIGINT")` devolve `exitCode:null` no Windows, mas o teste exigia 0 | Windows exige exatamente `{exitCode:null, signal:"SIGINT"}`; POSIX exige `{exitCode:0, signal:null}`                                                                                     |
| recursos     | Não medidos no teste original                                                   | Rebind real da porta e remoção do home depois da saída; esperas de SIGINT, bind e cleanup limitadas                                                                                      |

O vermelho no commit indicado passou no typecheck e a prova falhou nos
**dois IDs esperados** em cada Node (`2 failed | 1 passed`): índice -1
contra 2 e `exitCode:null` contra 0. Logs da prova em
`F:/lohra-849/red-proof20.log` e `red-proof22.log`, mais as execuções
baseline `red20.log` e `red22.log`. Não se inferiu falha de REST ou WS
a partir do resultado final do teste; essas asserções já tinham passado.

Na correção, o teste de argv mantém posição `importIndex+2` e compara a
lista completa, sem relaxar argumentos. O teste real usa `PATH` sem runtime
tools, verifica o corpo JSON do REST e o frame RFC6455 do WS. O SIGINT
enviado por `child.kill` no Windows é uma terminação observada, **não**
evidência de execução do handler gracioso. O teste exige o par code/signal
exato, reabre a porta e remove o home. O cleanup de falha usa apenas o
handle `ChildProcess` retornado pelo helper, com prazo e erro explícito;
não seleciona PID nem encerra processo alheio. Se o helper não confirmar
saída após o prazo, o teste falha; esta issue não altera o helper.

No SHA `76c82ed`, `npm run build`, `typecheck`, `lint`, `format:check` e
`npm run prova -- windows-dashboard-launcher-contract` retornaram 0 em
ambos os Nodes; prova **3/3**. Logs `F:/lohra-849/final20-*.log` e
`final22-*.log`. A suíte inteira Windows não foi repetida; #751 contém
o inventário residual de outras famílias. Dogfooding de provider/CLI é
N/A para mudança limitada a testes, declaração de prova e evidência.

No clone Linux próprio `/work/lohra849`, Node 22.23.3 e usuário `node`,
`npm ci` e os cinco gates canônicos retornaram 0 no SHA `76c82ed`:
**340 arquivos, 4.494 testes aprovados, 8 skips, 190,21 s**. A prova foi
**3/3**, incluindo o par POSIX `{exitCode:0, signal:null}` e os checks
reais de porta/home. O controle negativo automático com base/head/branch
explícitos retornou 0 com **SKIP mecânico** (`base+overlay ≡ head`), coerente
com a classe test-only; não é um negativo comportamental. Logs em
`F:/lohra-849/linux-logs/`. O vermelho Windows nos dois Nodes prende as
duas expectativas trocadas.

Comandos em cada clone, depois de `npm ci`, com Node da ABI indicada:

```text
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test -- --maxWorkers=1
npm run prova -- windows-dashboard-launcher-contract
npm run ci:controle-negativo -- --base c1dc5596a5fff72219cbfe6d28caec1b5942f275 --head 76c82edda05188ec1fe30887bfe77b242b1fe1e9 --branch test/849-windows-dashboard-launcher-contract
```

CI e revisão independente pertencem à PR e não são inferidos dos gates
locais.
