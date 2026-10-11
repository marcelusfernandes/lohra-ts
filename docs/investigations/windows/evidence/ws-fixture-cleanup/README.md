# Cleanup das fixtures WebSocket (#794)

Windows 11 x64, clones Git descartáveis com `npm ci` independente por ABI. Base
`0ea82ddc805c6c826a269af9b448e3c6b1844ac1`; correção de teardown nos commits
`d28cb3b` e `a76dbc5`. `HOME`, `USERPROFILE`, `TEMP`, `TMP`, `LOHRA_HOME`,
`CODEX_HOME`, `APPDATA`, `LOCALAPPDATA`, cache e prefixo npm foram exclusivos em F:
para cada Node. Nenhum provedor ou perfil pessoal foi usado.

| Medição                                                                                                                                                         |                                              Node 20.20.2 |                                              Node 22.23.2 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------: | --------------------------------------------------------: |
| `npm ci` em clone próprio                                                                                                                                       |                                                    exit 0 |                                                    exit 0 |
| Base: `node node_modules/vitest/vitest.mjs run tests/gateway/ws-connection.test.ts --maxWorkers=1 --reporter=json --outputFile=<evidence>/baseline-nodeXX.json` | exit 1, 14/14 falhas, 14 `EBUSY`, 14 `state.db` residuais | exit 1, 14/14 falhas, 14 `EBUSY`, 14 `state.db` residuais |
| Candidato: `npm run prova -- windows-ws-fixture-cleanup`                                                                                                        |                      exit 0, 14/14, zero raízes residuais |                      exit 0, 14/14, zero raízes residuais |

Os 14 erros de teardown da base não demonstram que as asserções do corpo
passaram; apenas registram a falha observável. O corpus candidato manteve as
mesmas expectativas de autenticação, frames e RPC. Os JSON integrais da base
ficaram fora do Git, em F:, porque contêm caminhos temporários. SHA-256:

| Reporter bruto         | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `baseline-node20.json` | `FDDF9B6A37BC5DF031682CFDA92B012A40E8C28F3F635AA78CEE26FC7E65F48A` |
| `baseline-node22.json` | `E23592769DF2B09509698E0B80D3D71847FD7A64A162EA9687A47B2044DE774A` |

A [sonda](probe.mjs) aceita só clone descartável marcado com
`.lohra-disposable-probe`. Ela troca temporariamente uma asserção existente por
uma expectativa falsa (`assertion`) ou lança após registrar o SQLite, antes de
iniciar o servidor (`setup`). Em ambos os casos restaura o arquivo fonte no
`finally`, executa apenas o teste `valid token: connects, then receives
gateway.ready`, registra reporter e log sanitizado e inspeciona as raízes
temporárias. Replay, com o `node.exe` correspondente e dependências próprias:

```text
node probe.mjs <clone-marcado> assertion <evidence-dir>
node probe.mjs <clone-marcado> setup <evidence-dir>
```

As quatro execuções saíram **1 pela falha deliberada**, com marcador da causa
original presente, `EBUSY=false` e zero raízes/`state.db` residuais:
[asserção Node 20](assertion-node20.json),
[setup Node 20](setup-node20.json),
[asserção Node 22](assertion-node22.json),
[setup Node 22](setup-node22.json). Os `.log` adjacentes substituem clone,
evidência e diretório temporário por marcadores. Saída de código 1 aqui é o
resultado esperado da sonda, não um gate verde fabricado.
