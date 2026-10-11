# #830 — caminhos de config e descoberta no Windows

O baseline `f74e0eb1a0a0cb53e4f23fc28e52815873941c84` foi executado em
clones descartáveis separados no volume F:, com dependências próprias para
Node 20.20.2 e Node 22.23.2. Em ambas as versões, o foco de
`tests/config.test.ts` e `tests/context.test.ts` teve **2 falhas e 26 passes**.
As diferenças completas foram:

| Campo                                      | Esperado antigo           | Recebido no Windows          |
| ------------------------------------------ | ------------------------- | ---------------------------- |
| `resolvePaths().home`                      | `/custom/profiles/myprof` | `\\custom\\profiles\\myprof` |
| `resolvePaths().envFile`                   | `/custom/.env`            | `\\custom\\.env`             |
| Primeiro label de `discoverInstructions()` | `backend/pkg/AGENTS.md`   | `backend\\pkg\\AGENTS.md`    |

`resolvePaths().base` permaneceu literalmente `/custom`, e `profile` permaneceu
`myprof`. O segundo label `CLAUDE.md`, a ordem nearest-first e os conteúdos
`near agents`/`root claude` permaneceram iguais. Assim, os valores medidos
confirmam uma divergência de separadores em campos derivados, não uma mudança
de precedência ou conteúdo.

O commit vermelho compilável `347677d` explicitou a preservação da base
literal e declarou a prova dos dois arquivos. `typecheck` passou e o foco
continuou vermelho (2/28) no Node 20. O commit verde `b4a1736` passou a
compor apenas `home`, `envFile` e o primeiro label com `node:path.join`
sobre constantes independentes da fixture. Não chama código do produto
para gerar o esperado, não normaliza o retorno e não altera nomes, casos,
marcadores, conteúdo ou ordem. O foco e
`npm run prova -- windows-config-context-paths` passaram 28/28 em Node 20/22;
build, typecheck, lint e format:check passaram nas duas versões.

Logs completos dos clones nativos, incluindo os diffs do vermelho e os
resultados dos gates, ficam em `F:/lohra-m25-830/{baseline,red,green,node20,node22}-*.log`.
Esses caminhos são evidência local externa ao repositório e não contêm
credenciais nem ambientes completos.

No Linux, um clone separado do bundle do commit `b4a1736` foi executado como
usuário `node`, com HOME e TMPDIR próprios: `npm ci` e os cinco gates passaram;
a suíte teve **340 arquivos e 4.470 testes aprovados, com 8 skips**. A prova
teve 28/28 e o controle negativo saiu 0 com `SKIP` mecânico por diff só de
testes/prova, sem alegação de assertion-red. O vermelho causal está nos
resultados nativos do baseline e no commit `test(red)` acima. Logs e códigos
de saída estão em `F:/lohra-m25-830/linux-gates/`.

Os clones nativos partiram do SHA base com overlay apenas dos três arquivos
versionados do candidato; o Linux executou a árvore do commit `b4a1736`.
Esta nota documental foi acrescentada depois desses gates, sem mudar bytes
dos testes ou da prova. A validação de formatação final cobre também a nota.
