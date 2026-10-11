# Leitura do payload do hook — #866

Base `548b4629f32f57bbecc1a9ac67913a62fc23d46b`; vermelho compilável
`a0f8b75b59af9a271888c92110650f4af18c0aea`; verde
`2e973ed998fe358103c11326a0b822d0938953b3`, seguida pelo ajuste
portátil do teste `57e77d2ac5e32f168a32539533d983207cf4d578` e pelo
endurecimento da pré-condição `dd13cf81b1d780e5c202478d4eac499bd91f0cbe`.
A reprodução anterior
`F:/lohra-m25-864/cat-absence-repro.mjs` motivou a investigação, mas os
testes desta branch executam o hook real com `sh` e `PATH` controlado na
fixture. Nenhuma configuração global foi alterada.

| Caso                                      | Vermelho Node 20/22                                        | Verde Node 20/22                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `cat` ausente, `node` presente            | hook exit 0, sem denial; stderr informa `cat` indisponível | exit 2, JSON `permissionDecision: deny`, razão sanitizada `falha de leitura do payload (status 127)`            |
| `cat` emite conteúdo parcial e encerra 17 | hook exit 0, sem denial                                    | exit 2, denial causal com status 17; nenhum byte da saída parcial ou dos marcadores de segredo em stdout/stderr |
| Casos normais e política existente        | 11 casos originais não alterados                           | prova 13/13 PASS em ambos os Nodes                                                                              |

O shell de `Git/bin/sh.exe` injeta `/usr/bin` no `PATH`, mesmo quando o filho
recebe um valor controlado. A fixture usa o executável irmão
`Git/usr/bin/sh.exe` quando disponível e confirma `command -v cat` e
`command -v node` antes de invocar o hook. Linux usa o `sh` descoberto.
Isso evita um falso teste de ausência no qual o shell encontra `cat` apesar
do `PATH` nominalmente restrito.

O hook agora verifica o status da substituição de comando antes de analisar
o payload. Em falha, descarta inclusive saída parcial, suprime o stderr do
leitor que poderia conter dados sensíveis e emite sua própria razão com o
status numérico. A leitura com exit 0 continua pela lógica anterior,
inclusive a política preexistente para JSON malformado; o guard de `node`
ausente e as regras de diretórios não foram alterados. Não há mudança no
runtime ou tarball; dogfooding de provider é N/A.

Na primeira suíte Linux no SHA `2e973ed`, a pré-condição de `command -v cat`
do teste novo exigia status 1; o `sh` da bancada retornou 127 para comando
ausente. O ensaio terminou exit 1 com 339 arquivos aprovados, 4.475 testes
aprovados, 8 skips e 1 falha nessa asserção de setup, antes de invocar o hook
nesse caso. O log foi preservado em `F:/lohra-866/linux-test-first-failed.log`.
O commit `57e77d2` exige status **não-zero**; `dd13cf8` também exige que o
lançamento do shell não tenha erro, que o status seja numérico e que stdout
seja vazio. O probe de `node` confirma disponibilidade e status 0. A prova
focal Linux passou 13/13 no SHA final.

No SHA `57e77d2`, cinco gates Linux passaram: 340 arquivos, 4.476 testes
aprovados, 8 skips, 182,30 s; prova 13/13. O produto não mudou em `dd13cf8`;
nesse commit, typecheck, format:check e prova Linux repetiram exit 0. O
controle negativo automático retornou exit 0 com **SKIP mecânico**
(`base+overlay ≡ head`), portanto não conta como negativo comportamental.
Num clone Linux próprio no SHA `dd13cf8`, a sobreposição temporária **apenas**
do hook da base `548b462` com os testes finais fez a prova falhar nos dois
casos novos (exit 1). Depois de restaurar os bytes do hook, a prova voltou
a 13/13 exit 0; SHA-256 do hook salvo/restaurado idêntico e `git status`
limpo. Logs em `F:/lohra-866/linux-proof-base-hook-dd.log` e
`linux-proof-restored-dd.log`. Essa medição é o negativo causal; a primeira
suíte Linux falha continua registrada separadamente como erro de setup.

Comandos no checkout após `npm ci`:

```text
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run prova -- write-hook-reader-failure
npm test -- --maxWorkers=1
npm run ci:controle-negativo -- --base 548b4629f32f57bbecc1a9ac67913a62fc23d46b --head dd13cf81b1d780e5c202478d4eac499bd91f0cbe --branch fix/866-write-hook-reader-failure
```

Logs brutos da matriz nativa em `F:/lohra-866/native{20,22}-*.log`;
prova verde 13/13 e build, typecheck, lint, format:check exit 0 em Node
20.20.2 e 22.23.2. Os diretórios de ABI, HOME, cache npm e TEMP foram
isolados em F:. A suíte completa Windows não foi repetida; #751 registra a
linha de base com outras famílias de falha. CI e revisão independente serão
medidos na PR, não inferidos destes ensaios.
