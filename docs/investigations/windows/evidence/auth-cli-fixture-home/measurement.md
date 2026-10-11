# #840 — home da fixture de autenticação da CLI

O baseline `9dbc78ffb5443eee6d6b8656669d4c937055d01d` foi medido em
clones descartáveis separados no volume F:, com dependências próprias para
Node 20.20.2 e Node 22.23.2. O foco `tests/auth-cli.test.ts` teve **3 falhas
e 1 passe** em cada versão:

| Caso            | Esperado                              | Recebido                               |
| --------------- | ------------------------------------- | -------------------------------------- |
| Chat sem login  | `model: "gpt-5.5"`, `api_calls: 0`    | `model: null`, `api_calls: 0`          |
| Gate de `serve` | stderr contém `gate is unconditional` | stderr inicia `no provider configured` |
| `doctor --json` | exit 0                                | exit 2                                 |

O primeiro caso de status/consentimento já passava. A fixture escrevia
`writeConfig` e `writeTokens` em `home/.lohra`, mas entregava ao `runCli`
um ambiente com `HOME` e `CODEX_HOME`, sem `LOHRA_HOME`; o default de plataforma
apontava para outro diretório no Windows. O `probeOllama` da fixture retorna
`false` sem rede, e o ambiente entregue à CLI é um objeto explícito com
dados dummy, sem credenciais reais.

O commit vermelho compilável `489ef05` adicionou a igualdade explícita
`environment.LOHRA_HOME === home` e declarou a prova do arquivo original.
`typecheck` saiu 0 e o foco permaneceu vermelho (4 falhas/4) em Node 20;
o baseline original já demonstrava as três falhas históricas em ambas as
ABIs. No commit verde `681bc79`, `LOHRA_HOME` usa exatamente o mesmo
`lohraHome` retornado pela fixture, enquanto `CODEX_HOME` continua isolado.
Depois disso, chat e serve passaram; doctor passou exit/payload, revelando
apenas um literal POSIX no detalhe do caminho de `auth.json`. O esperado
agora usa `node:path.join(value.home, "auth.json")`, preservando a igualdade
exata do array de três detalhes, incluindo data de expiração, em vez de
normalizar a saída. O foco final passou **4/4** em Node 20/22. Nas duas
versões também passaram `npm run build`, `typecheck`, `lint`, `format:check`
e `npm run prova -- windows-auth-cli-fixture-home` (4/4).

Logs nativos completos e sanitizados estão em
`F:/lohra-m25-840/{baseline,red,green,green-final,node20,node22}-*.log`.
Os clones Windows executaram a base com overlay apenas do teste e da prova;
os arquivos medidos têm os mesmos hashes que o candidato. Não houve chamada
de provider, leitura de login do operador nem alteração de `src/` ou ACL.

No Linux, um clone separado do bundle do commit `681bc79` rodou como usuário
`node`, com HOME e TMPDIR próprios. `npm ci` e os cinco gates passaram: a
suíte completa teve **340 arquivos e 4.476 testes aprovados, com 8 skips**;
a prova passou 4/4. O controle negativo saiu 0 com `SKIP` mecânico por diff
somente de testes/prova, sem alegação de assertion-red; a causa do vermelho
foi medida no baseline nativo e no commit `test(red)`. Os logs e exits estão
em `F:/lohra-m25-840/linux-gates/`. Esta nota documental foi adicionada
depois dos gates e será incluída na verificação final de formatação.
