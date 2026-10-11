# #820 — home das fixtures integradas de chat

## Candidato e isolamento

- Base: `b9832ab885dfdb4133a2ff98c6ca7a68197ef77e`; vermelho documental: `6c6e297`; código candidato: `dcecae1877752e5c4129113b97441fb4aff20e47`.
- Windows 11 x64: Node 20.20.2 portátil e Node 22 do host, em clones e instalações `npm ci` independentes sob `F:/lohra-m25-820/node20` e `node22`. `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, cache npm e temporários apontaram para diretórios próprios por versão em `F:`; nenhum provider real foi chamado.
- Linux: clone próprio `/work/lohra820`, usuário não privilegiado `node`, ambiente e temporários próprios em `/tmp/lohra820-*`; bundle do mesmo SHA em `F:/lohra-m25-820/code-dcecae1.bundle`.

## Vermelho nativo

`npm ci` passou nas duas ABIs. O foco antes da correção (`npm test -- --maxWorkers=1 tests/chat-prompt-caching.test.ts tests/chat-audit-trail-wiring.test.ts tests/chat-provider-detectado.test.ts`) retornou **7 PASS e 7 FAIL de 14 casos** em cada versão. As sete causas primárias foram `ENOENT` no `lstat` de `<tmp>/<fixture>/.lohra`, em `src/media/persistence.ts:76`:

| Fixture                                                                            | Falhas primárias por ABI |
| ---------------------------------------------------------------------------------- | -----------------------: |
| `chat-prompt-caching`: blocos do system prompt, última tool, banda context, resume |                        4 |
| `chat-audit-trail-wiring`: sink de auditoria                                       |                        1 |
| `chat-provider-detectado`: detecção e precedência explícita                        |                        2 |

Cada falha primária teve um `EBUSY` secundário na limpeza de `lohra/state.db`. Os logs brutos `F:/lohra-m25-820/baseline-{20,22}.log` preservam os IDs completos, stacks e sete nomes de diretórios residuais por ABI. Os resíduos estão exclusivamente dentro de `F:/lohra-m25-820/isolation-{20,22}/temp`; não foram apagados para não perder a evidência. Não se atribui `EBUSY` genérico à diferença de home: ele ocorreu durante teardown após os `ENOENT`. O foco verde posterior criou **zero resíduos novos** nesses diretórios.

## Mudança e verde nativo

As nove invocações `runChat` nos três arquivos agora declaram `environment.LOHRA_HOME` igual ao `home` explícito; as duas chamadas de resume compartilham o mesmo `baseEnvironment`. Os 14 nomes, assertions e marcadores de teste permaneceram intactos; `src/` e ambiente global não mudaram. O mesmo foco passou **14/14** em Node 20 e 22, logs `green-focus-{20,22}.log`.

SHA-256 dos quatro arquivos copiados ao verde foi conferido idêntico ao worktree candidato nas duas ABIs: `chat-prompt-caching` `87351CD0...`, `chat-audit-trail-wiring` `A9F95747...`, `chat-provider-detectado` `B993E425...`, prova `DD215535...`. Cada clone continua pinado na base para não reescrever o histórico do vermelho; estes hashes, junto com a lista de quatro arquivos, identificam exatamente o overlay medido.

| Gate                                         |  Node 20 |  Node 22 |
| -------------------------------------------- | -------: | -------: |
| `npm run build`                              |        0 |        0 |
| `npm run typecheck`                          |        0 |        0 |
| `npm run lint`                               |        0 |        0 |
| `npm run format:check`                       |        0 |        0 |
| `npm run prova -- windows-chat-fixture-home` | 0; 14/14 | 0; 14/14 |

Logs por etapa: `F:/lohra-m25-820/{build,typecheck,lint,format,proof}-{20,22}.log`. Os resumos da prova em cada clone têm `{"ok":true,"total":14,"falhas":[]}`. Dogfooding real: **N/A**, porque o diff contém somente testes, declaração de prova e esta evidência.

## Linux e controle negativo

No SHA `dcecae1`, `npm ci` e os cinco gates canônicos concluíram com exit 0. A suíte completa com `--maxWorkers=1` concluiu **337 arquivos, 4.416 PASS + 4 skips**, em 146,16 s; os três arquivos alterados passaram dentro dela. A prova concluiu **14/14**. O controle negativo retornou exit 0 e `SKIP — diff só de tests/**+prova/**: base+overlay ≡ head`; para esta classe, o vermelho comportamental é o foco nativo medido antes do overlay. A contagem total aumenta em um caso em relação ao 4.415 do baseline Linux vizinho porque `prova/windows-chat-fixture-home.ts` acrescenta uma declaração descoberta pelo corpus de provas, não porque alguma das 14 assertions do foco foi movida.

Resultados e logs completos: `F:/lohra-m25-820/linux-evidence/{results.tsv,head.txt,status.txt,npm-ci.log,build.log,typecheck.log,lint.log,format.log,test.log,prova.log,negative.log}`. `head.txt` é `dcecae1877752e5c4129113b97441fb4aff20e47`; `status.txt` está vazio. O código do candidato foi medido antes desta edição só documental da evidência; após o commit documental, `format:check` deve ser confirmado no HEAD final.
