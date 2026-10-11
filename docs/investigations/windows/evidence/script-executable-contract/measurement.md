# #823 — modo executável do script de skills

Base `8d280c3b5635f931d66ab713c9e69d664ecb9095`; vermelho compilável
`348facbe706428cc7f571ec58a6c46e9cd14aa3c`; código final
`486c7b6d0c5c2e3d3b7b080923313da6587e0514`. As medições Windows usam
clones Git independentes em `F:/lohra-m25-823/`, com `npm ci`, módulos nativos,
home, TEMP, cache e prefixo npm separados por ABI. Node 20.20.2/npm 10.8.2 e
Node 22.23.2/npm 10.9.8, Windows 11 x64. O clone com `aux.ts` usa
`core.protectNTFS=false` local, sem alterar configuração global.

Em ambos os clones vermelhos,
`git ls-files --stage -- .claude/skills/pr/scripts/secao.sh` retornou
`100755 1b9fcf838cdd9aecedac874fc79ec553d6e03d43 0` seguido por tab e
`.claude/skills/pr/scripts/secao.sh`, enquanto
`statSync(SECAO).mode & 0o111` retornou `0`. O teste vermelho compilou
(`typecheck` exit 0) e o foco do arquivo teve **2 falhas e 11 aprovações** nas
duas ABIs: o stub explícito `not implemented` falhou tanto no contrato real
quanto na fixture isolada. O ID original no inventário #751 é
`b3c17b6580bbba57`; esta medição distingue índice Git de projeção NTFS.

No candidato, a verificação lê `git ls-files --stage` com `shell:false` e
argumentos separados; exige entrada única, stage 0, hash hexadecimal de 40 ou
64 caracteres e modo `100755`. Índice ausente, formato inesperado ou falha de
Git lançam causa; um
modo `100644` lança mensagem com modo observado e esperado. A fixture cria
somente seu repositório temporário, grava um blob e alterna seu índice próprio
por `git update-index --cacheinfo`: 100644 deve lançar, 100755 deve passar.
Ela também verifica entrada ausente e diretório Git inválido. `finally`
remove apenas a fixture criada pelo teste. O índice, ACLs e a configuração
global do checkout compartilhado não são modificados. No POSIX, o mesmo caso
continua exigindo `statSync(SECAO).mode & 0o111`; os casos que executam o
script permanecem no arquivo e sem skips.

No SHA de código `486c7b6`, os clones finais ficaram limpos e produziram:

| Medição                                          | Node 20 | Node 22 |
| ------------------------------------------------ | ------- | ------- |
| `npm ci`                                         | exit 0  | exit 0  |
| build → typecheck → lint → format:check          | 4 × 0   | 4 × 0   |
| Foco `tests/claude-skills-scripts.test.ts`       | 13/13   | 13/13   |
| Prova `windows-script-executable-contract`       | 13/13   | 13/13   |
| Prova de integração `windows-process-shell` #812 | 72/72   | 72/72   |

O código intermediário `6ef8ebd` ainda reprovou `lint` nas duas ABIs por seis
erros de estilo nos callbacks e na mensagem de modo; a correção está em
`486c7b6`. Os resultados verdes acima foram repetidos no último SHA de código,
sem classificar o `lint` intermediário como aprovado. Logs correspondentes:
`F:/lohra-m25-823/stable2-{20,22}-*.log`. O foco 13/13 foi medido após a
correção do controle 100644 em ambos os Nodes; a prova final executa o mesmo
arquivo inteiro.

Comandos principais, executados na raiz de cada clone com ambiente isolado:

```text
<node.exe> <npm-cli.js> ci --no-audit --no-fund
<node.exe> <npm-cli.js> run build
<node.exe> <npm-cli.js> run typecheck
<node.exe> <npm-cli.js> run lint
<node.exe> <npm-cli.js> run format:check
<node.exe> <npm-cli.js> run prova -- windows-script-executable-contract
<node.exe> <npm-cli.js> run prova -- windows-process-shell
```

`<node.exe>` foi o executável portátil 20.20.2 verificado em F: ou o Node
22.23.2 instalado; `<npm-cli.js>` veio da mesma distribuição de Node. O foco
vermelho/verde usou `node node_modules/vitest/vitest.mjs run
tests/claude-skills-scripts.test.ts --maxWorkers=1`. Logs brutos, código de
saída e resumos das provas ficam em `F:/lohra-m25-823/`. A prova de integração
`windows-process-shell` confirma que a falha residual de #812 foi eliminada
sem mudar o launcher. Dogfooding N/A: só testes, prova e esta evidência foram
alterados.

No clone Linux Node 22 do código `486c7b6`, executado como usuário `node`
(uid 1000) com `HOME`, `LOHRA_HOME`, `CODEX_HOME`, `TMPDIR` e cache npm
isolados, `npm ci` e os cinco gates canônicos tiveram exit 0. A suíte
`npm run test -- --maxWorkers=1` passou **337 arquivos, 4.415 testes** e
registrou quatro skips, em 151,36 segundos. A prova nova passou **13/13**.
`npm run ci:controle-negativo -- --base 8d280c3b5635f931d66ab713c9e69d664ecb9095 --head 486c7b6d0c5c2e3d3b7b080923313da6587e0514 --branch test/823-windows-script-executable-contract`
retornou exit 0 e **SKIP
mecânico**: o diff de código é só `tests/**` e `prova/**`, logo overlay e HEAD
não discriminam; o vermelho compilável `348facb` é a evidência manual.
O clone Linux terminou com `git status --short` vazio. Logs estão em
`F:/lohra-m25-823/linux-*.log` e o bundle verificado em
`F:/lohra-m25-823/issue-823-stable.bundle`.
