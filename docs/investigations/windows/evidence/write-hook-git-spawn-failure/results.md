# Falha ao lançar Git no hook — #873

Base `eaa33abbc65fd4fabb1a7b3c064100edae24d7e2`; vermelho compilável
`5ab3b344467191850405600fa95a5f685a809b4f`; correção
`3f0b154197c05ec8d46cba8218b11fa9d9211365`; candidato medido
`129ae6682877b850a5f567d7ece6877e606ade83` (acrescenta uma asserção
numérica ao controle de scratch, sem mudar produção). Checkout Windows,
clones de ABI e homes/cache/TEMP próprios em `F:/lohra-873/`; nenhuma
configuração global de Git ou PATH foi alterada.

| Cenário                                        | Vermelho Node 20/22                                                                 | Candidato Node 20/22                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `git` ausente; `cat` e Node disponíveis        | hook retorna 0 sem diagnóstico                                                      | retorna 2 com recusa `git (ENOENT)`; sem payload/stack                         |
| `spawnSync(git)` com falha controlada `EACCES` | hook retorna 0 sem diagnóstico                                                      | retorna 2 com recusa `git (EACCES)`; sem mensagem/stderr sintéticos ou payload |
| Git funcional, alvo protegido                  | controle confirma lançamento do Git com status 0                                    | recusa de escrita existente mantida                                            |
| Git funcional, scratch externo                 | controle confirma Git lançado, status **numérico** não-zero e sem `spawnSync.error` | operação permitida; status não-zero comum não vira erro de lançamento          |

O `ENOENT` é falha real de lançamento com Git removido somente do `PATH` do
filho; a fixture confirma separadamente a disponibilidade de `cat` e Node e
a ausência de Git. O `EACCES` é um fault injetado via preload **somente no
processo Node filho** do hook; não mede ACL nem negação nativa do sistema
operacional. A fixture usa `Git/usr/bin/sh.exe` no Windows para evitar que
`Git/bin/sh.exe` reintroduza `/usr/bin` no `PATH`. Em ambos os casos o hook
real recebe `Write` para alvo protegido em repositório próprio. Não expõe o
marcador sintético de payload, mensagem de erro ou stderr de Git na recusa.
Os 13 casos anteriores, incluindo alias e falha de leitura de #866, foram
mantidos sem skip ou afrouxamento.

O controle vermelho falhou nos dois casos novos em cada Node (exit 1,
`2 failed | 13 skipped`), com o hook retornando 0 quando se esperava 2.
Logs em `F:/lohra-873/red20.log` e `red22.log`; typecheck vermelho exit 0.
No candidato, `npm run build`, `typecheck`, `lint`, `format:check` e
`npm run prova -- write-hook-git-spawn-failure` retornaram 0 em Node
20.20.2 e 22.23.2; a prova registrou **15/15** em cada um. Logs nativos
`F:/lohra-873/native20-*.log` e `final22-*.log`.

No clone Linux próprio `/work/lohra873`, Node 22.23.3, `npm ci` e os cinco
gates canônicos retornaram 0 no SHA candidato: 340 arquivos, 4.490 testes
aprovados, 8 skips, 185,08 s. A prova retornou 15/15. O primeiro comando
local de controle negativo, sem `--base/--head/--branch`, retornou 1 por
invocação incompleta; não é falha do produto. A invocação correta retornou
0 com **SKIP mecânico** (`base+overlay ≡ head`), não é evidência de red
comportamental.

Para o negativo causal, no mesmo clone Linux limpo, salvei o hook candidato,
sobrepus temporariamente **apenas** o hook da base e rodei os testes finais:
prova exit 1, exatamente os dois casos novos falhando porque o hook retornou 0. Restaurei o hook salvo: prova 15/15 exit 0, SHA-256 antes/depois idêntico
(`f5f53d8f73b7fc8bbbff1283ea6690242ae1521b9f9513458120e64b9991eae5`)
e `git status` limpo. Comando e logs em `F:/lohra-873/manual-negative.sh`
e `F:/lohra-873/linux-logs/`; não houve escrita no checkout principal.

Comandos reproduzíveis após `npm ci`, em cada clone com Node da ABI indicada:

```text
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test -- --maxWorkers=1
npm run prova -- write-hook-git-spawn-failure
npm run ci:controle-negativo -- --base eaa33abbc65fd4fabb1a7b3c064100edae24d7e2 --head 129ae6682877b850a5f567d7ece6877e606ade83 --branch fix/873-write-hook-git-spawn-failure
```

A suíte completa Windows não foi repetida: #751 registra as famílias
residuais fora deste escopo. Dogfooding de CLI/provider é N/A para mudança
restrita a hook, testes, prova e evidência. CI e revisão independente ainda
dependem da PR; estes resultados não os antecipam.
