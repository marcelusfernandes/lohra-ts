# Caminho nativo de `workflow_tiers.json` — #842

Base `412700e05a3c3f56d924ecc1711f1c9b1e180a1b`; vermelho compilável
`c40bafb5470ec8fb8b2692a1ead24d42e0400235`; código verde
`611f33381a17dd1b1ed0fe9cbda213117c201247`. Logs brutos e bundles
ficaram em `F:/lohra-m25-842/`. Os homes, caches npm, diretórios temporários e
instalações de dependências foram próprios de cada ABI em F:, sem credenciais.
Ambiente: Windows 11 Pro build 26200 x64, Node 20.20.2 e 22.23.2; Linux
Node 22.23.3 no container `lohra-m25-linux-737-20261009` como UID 1000.

| Medição                                                                | Windows Node 20                     | Windows Node 22                            | Linux Node 22                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Base, focais existentes                                                | não repetida                        | exit 1: 4 falhas de caminho misto, 24 pass | os 4 casos passam porque `/` é nativo                                                                            |
| Vermelho `c40bafb`, dois casos novos com `home` terminado em separador | exit 1: 6 falhas, 24 pass           | exit 1: 6 falhas, 24 pass                  | exit 1: 2 falhas, 28 pass; `home//workflow_tiers.json` não contém o caminho nativo esperado                      |
| `npm ci` ABI própria                                                   | exit 0                              | exit 0                                     | exit 0                                                                                                           |
| build → typecheck → lint → format:check, código `611f333`              | 0 → 0 → 0 → 0                       | 0 → 0 → 0 → 0                              | 0 → 0 → 0 → 0                                                                                                    |
| `npm run prova -- native-tiers-command-path`                           | exit 0, 30/30                       | exit 0, 30/30                              | exit 0, 30/30                                                                                                    |
| `npm test -- --maxWorkers=1`                                           | não repetido; baseline Windows #751 | não repetido; baseline Windows #751        | exit 0, 340 arquivos, 4.462 pass, 8 skips; 186,96 s                                                              |
| Controle negativo, base→verde, sem `--slug`                            | não repetido                        | não repetido                               | exit 0, `assertion-red — PASS`, uma falha independente por comando                                               |
| Mutantes externos, concatenação literal isolada por comando            | não repetidos                       | não repetidos                              | `models` exit 1/assertion-red; `tiers` exit 1/assertion-red; ambas as fontes restauradas byte a byte e Git limpo |

O vermelho Windows preserva os quatro casos históricos e acrescenta apenas
dois casos com separador final. O valor recebido no diagnóstico misturava
`F:\...\home/workflow_tiers.json`; a expectativa original era
`join(home, "workflow_tiers.json")`. No Linux, a concatenação duplicava a barra
final. Os testes continuam a exigir exit 1, canal correto, erro causal e
`neverProbe` na configuração inválida; não há aceitação permissiva de caminhos.
O script [mutate-path.mjs](mutate-path.mjs) troca temporariamente um único
`join` por concatenação, executa a asserção correspondente e restaura os bytes
no `finally`. O resultado de ambas as mutações está em
[mutations.json](mutations.json); os logs focais estão em
`F:/lohra-m25-842/linux-logs/mutant-{models,tiers}.log`.

Dogfooding real no código `611f333`: o orquestrador buildou a CLI candidata e
executou `chat --json --no-input` com provider real. A única chamada `terminal`
rodou um wrapper Node em fixture própria com espaço no caminho e `LOHRA_HOME`
terminado em separador. O wrapper invocou as CLIs candidatas `models --json` e
`tiers list` sobre tiers inválidos e exigiu exit 1, canais e diagnóstico **exatos**
com caminho nativo. Ambas passaram. A conversa externa encerrou com exit 0,
`error:null`, ferramenta `ok:true`/exit 0 e marcador em stdout com LF. Projeções
sem segredos: [dogfood-orchestrator-result.json](dogfood-orchestrator-result.json)
e [dogfood-nested-result.json](dogfood-nested-result.json). A fonte parametrizada
é [dogfood.mjs](dogfood.mjs). A primeira tentativa do verificador exterior
esperava CRLF; o wrapper e as CLIs já tinham passado. A repetição aceitou LF
ou CRLF e mediu LF. `NODE_NO_WARNINGS=1` só foi aplicado aos subprocessos de
diagnóstico para comparar stderr exato; a CLI exterior emitiu 100 bytes de
warnings e seus dados brutos não foram versionados.

Reprodução após `npm ci` no checkout candidato:

```text
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run prova -- native-tiers-command-path
npm test -- --maxWorkers=1
npm run ci:controle-negativo -- --base 412700e05a3c3f56d924ecc1711f1c9b1e180a1b --head 611f33381a17dd1b1ed0fe9cbda213117c201247 --branch fix/842-native-tiers-command-path
node docs/investigations/windows/evidence/native-tiers-command-path/mutate-path.mjs <CHECKOUT> <OWN_OUTPUT_DIR>
```

A suíte completa, o controle negativo e os mutantes foram medidos no Linux;
CI e revisão independente ainda não são inferidos destes gates locais.
