# #827 — limpeza das fixtures de eventos WS

Base `ded8d27d752949d9c947b16ad49554092b3c396c`; declaração vermelha `32dc764ed456e4f3720ba00801fbd4b30b90057e`; código verde `afd8e58166f8c8c15b73cd6b9b0bd32940ac95d3`; ajuste somente de formatação `55792f66227ada75e13e310db502f3c830c7725c`. As medições nativas usam clones descartáveis com `npm ci` próprio por ABI, Node 20.20.2 e Node 22.23.3, e `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, cache npm e `TEMP` fora dos clones.

| Focal na base                                 | Node 20                                  | Node 22                                  |
| --------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `tests/gateway/ws-connection-notices.test.ts` | 2 testes, 2 falhas `EBUSY` em `state.db` | 2 testes, 2 falhas `EBUSY` em `state.db` |
| `tests/gateway-compaction-events.test.ts`     | 5 testes, 3 aprovados e 2 falhas `EBUSY` | 5 testes, 3 aprovados e 2 falhas `EBUSY` |
| Prova declarada antes da correção             | exit 1                                   | exit 1                                   |

Nos dois arquivos, a raiz entra no registro imediatamente após sua criação e a conexão é registrada logo após `openStateDatabase` retornar. O teardown tenta fechar sockets, servidor, banco e raiz, preservando falhas individuais em `AggregateError` e prosseguindo para os recursos seguintes. Em compactação, `vi.unstubAllEnvs()` também tem falha coletada. Os corpos de teste desde os blocos `describe` relevantes são idênticos à base: 2 casos de avisos e 5 de compactação/modelo, com nomes, marcadores e asserções inalterados.

O [driver completo das sondas](probe-source.md) instrumenta cópias temporárias dos dois arquivos somente nos clones descartáveis. Para cada fixture e ABI, induz falha de setup após registro do banco, falha de assertion com socket ativo, falha de fechamento do servidor após verificar rebind da porta, e falha de fechamento do banco após fechar a conexão real. Nas **16 execuções válidas**, Vitest retornou exit 1 com uma falha induzida, causa primária e secundária esperadas presentes, sem `EBUSY` e sem resíduo no `TEMP` isolado; as 12 execuções com servidor verificaram rebind da mesma porta. Uma primeira tentativa de filtro da sonda de compactação Node 20 selecionou zero casos e foi arquivada como inválida; o driver corrigido executou o caso real antes de qualquer conclusão.

As saídas brutas, fontes instrumentadas e resultado JSON por cenário estão em `F:/lohra-m25-827/` na máquina de medição. SHA-256 do driver executado: `f473884db15d96332c8c69b33d30c6035b7209a1a074892c176dd225ca6f81b4`. O driver usa caminhos locais de F e executáveis Node explícitos; substitua essas constantes para reproduzir em outra máquina. A verificação de rebind cobre servidor que conclui `close()`; não promete liberar porta se esse método falhar antes de encerrar o listener. Dogfooding do runtime: N/A, pois a mudança limita-se a testes, prova e documentação.

## Gates

Na primeira rodada em `afd8e58`, `npm ci`, build, typecheck e lint Linux passaram, mas `format:check` falhou por um import longo em `ws-connection-notices.test.ts`; o mesmo ocorreu no Node 20. Esses logs foram preservados e não contam como gate verde. O commit `55792f6` altera somente a quebra de linhas desse import.

No SHA `55792f6`, Node 20 e 22 passaram `build`, `typecheck`, `lint`, `format:check` e a prova `npm run prova -- windows-ws-event-fixture-cleanup` com **7/7**. O clone Linux próprio passou `npm ci` e os cinco gates canônicos com exit 0: **336 arquivos, 4405 testes aprovados e quatro skips preexistentes**, suíte reportando 205,19 segundos; prova 7/7 exit 0. Logs ficam em `F:/lohra-m25-827/linux-final/`.

O wrapper da rodada Linux imprimiu todos os exits 0, mas terminou com exit 1 por linhas CRLF extras no próprio shell script; isso não é contado como gate de produto. Além disso, a primeira invocação do controle negativo usou um nome de branch errado no argumento. A invocação corrigida, com `--branch test/827-windows-ws-event-fixture-cleanup`, terminou exit 0 com `SKIP` test-only: base+overlay equivale ao head; o commit `test(red)` e os vermelhos nativos constituem a discriminação comportamental. O log corrigido é `linux-final/control-negative-correct.log`. A suíte completa não foi repetida por esses erros do wrapper após seus resultados exit 0. Este código foi medido antes da nota documental; CI e revisão independente ficam para a PR.
