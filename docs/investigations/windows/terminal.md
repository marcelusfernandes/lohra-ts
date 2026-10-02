# W3 — Terminal, arquivos e processos no Windows nativo (#703)

## Escopo e ambiente

Investigação documental em Windows 11 x64 nativo, no SHA
`fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`, com Node 20.20.2 e 22.23.3
x64. As dependências foram usadas nos clones temporários `clone-workaround` e
`clone-workaround-22` do #701, ambos no mesmo SHA; o worktree desta issue não
recebeu dependências. Os dados de sonda ficaram exclusivamente em um diretório
descartável sob `%TEMP%`, com subpastas distintas por versão. Nenhum provedor
remoto ou credencial foi usado. WSL, outras arquiteturas e outras versões de
Windows são **NOT_MEASURED**.

`AGENTS.md` prevê TUI/GUI no futuro; os resultados abaixo se referem às tools
e ao filtro de workflow que existem hoje. `terminalTool` usa `node-pty`, cria
`cmd.exe /d /s /c` em Windows e encapsula o comando com redireções para
arquivos temporários (`src/tools/terminal.ts:61-74,104-159`). As tools de
arquivo usam `readFileSync`/`writeFileSync` no host
(`src/tools/filesystem.ts:65-110`).

## Matriz de resultados

| Caso                                                                  | Esperado                                                         | Node 20                                                                                     | Node 22                                         | Conclusão                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| UTF-8, espaço, Unicode, `CRLF`/`LF`, drive `C:`, barras Windows e `/` | `write_file` e `read_file` preservam conteúdo e bytes            | 31 bytes iguais; conteúdo igual nas duas grafias do caminho                                 | Mesmo resultado                                 | **PASS** nos caminhos medidos                                                                    |
| Nome reservado `aux.txt` em `%TEMP%`                                  | Registrar comportamento                                          | Escrita e `existsSync` bem-sucedidos                                                        | Mesmo resultado                                 | **PASS observado**, sem generalizar a todos os nomes reservados ou APIs                          |
| Caminho longo (427 caracteres)                                        | Registrar limite observado                                       | Escrita e leitura bem-sucedidas                                                             | Mesmo resultado                                 | **PASS observado** nesse comprimento; limite máximo **NOT_MEASURED**                             |
| Symlink para arquivo fora da raiz de trabalho                         | Registrar privilégio e confiança                                 | Criado; leitura igual; `untrusted: true`                                                    | Mesmo resultado                                 | **PASS** de criação/leitura/marcação; a marcação não bloqueia a leitura                          |
| `terminalTool`: stdout, stderr, código 7 e cwd com espaço             | Executar comando e devolver saídas/código                        | stdout vazio, código 1, erro de sintaxe do `cmd.exe`                                        | Mesmo resultado                                 | **FAIL**; comando não chegou ao efeito pretendido                                                |
| `terminalTool`: timeout de 0,5 s                                      | Encerrar processo que realmente iniciou e verificar descendentes | Envelope `command timed out after 0.5s`, mas comando já falha por sintaxe                   | Mesmo resultado                                 | **BLOCKED** para semântica de filho/neto da tool; envelope de timeout isolado não prova execução |
| PTY nativo direto, sem wrapper do produto                             | Criar processo real                                              | PID registrado, marcador recebido, código 0                                                 | Mesmo resultado                                 | **PASS**; addon funciona, distinto da tool                                                       |
| Kill de PTY direto com pai e neto controlados                         | Ambos desaparecem após `kill()`                                  | PIDs 63584/58456 vivos antes, ausentes após 1 s                                             | PIDs 36364/33844 vivos antes, ausentes após 1 s | **PASS** para a sonda direta; não prova cancelamento do `terminalTool`                           |
| Política de comando perigoso (`sudo`)                                 | Recusa antes de executar                                         | `refusal: final`                                                                            | Mesmo resultado                                 | **PASS** para o padrão medido                                                                    |
| Filtro workflow: arquivo dentro/fora da raiz                          | Dentro aceito; fora recusado                                     | Dentro recusado; fora recusado; a raiz exata aceita                                         | Mesmo resultado                                 | **FAIL** de caminho filho válido no Windows                                                      |
| Filtro workflow: terminal e egress                                    | Entender limites                                                 | `terminal` passa pelo filtro; `web_fetch` sem host permitido é recusado; `web_search` passa | Mesmo resultado                                 | **PASS observado** da política por nome de tool; não é sandbox de SO                             |
| Shell externo PowerShell/cmd                                          | Mesmo comportamento interno do `terminalTool`                    | Ambos retornaram código 1 e erro de sintaxe; `cmd` executou o harness com exit 0            | Node 22 do shell externo **NOT_MEASURED**       | **FAIL** da tool independente do shell externo medido                                            |

Saídas compactas, comandos e PIDs estão em
[`evidence/terminal/measurements.md`](evidence/terminal/measurements.md). O
teste existente de tools foi executado nos dois Nodes: **21 PASS, 7 FAIL,
exit 1** em cada um. O resumo das falhas está em
[`evidence/terminal/tests.md`](evidence/terminal/tests.md). `git` não sofreu
alterações além desta documentação e evidência.

## Diagnóstico e limites

A falha do terminal é específica do caminho Windows do produto: um
`cmd.exe` invocado diretamente com redireções equivalentes produziu `OUT`, e
`node-pty` direto produziu `PTY-DIRECT`. Já `terminalTool` devolveu
`"ok":true,"exit_code":1`, stdout vazio e `A sintaxe do nome do arquivo,
do nome do diretório ou do rótulo do volume está incorreta.`. Assim, o
envelope `ok` indica que a tool conseguiu iniciar o shell e coletar seu
resultado, não que o comando solicitado teve êxito. Este relatório não fixa
uma causa de quoting sem uma reprodução mínima do argv em `node-pty`.

No filtro de workflow, `isWithin` compara o prefixo com `resolvedRoot + "/"`
(`src/workflow/sandbox.ts:89-97`). Os caminhos reais no Windows usam `\`,
então um filho de `workingRoot` é negado. A comparação de igualdade da raiz
passou na mesma sonda. A política só inspeciona `read_file`/`write_file` e
`web_fetch`/`web_search` por nome (`src/workflow/sandbox.ts:59-60,146-169`);
`terminal` não recebe restrição de raiz ou egress nesse wrapper. A guarda de
subagente rejeita alguns comandos por expressão regular
(`src/tools/child.ts:62-89`), e a tool de terminal aplica sua própria política
(`src/tools/approval.ts:69-110`). Nenhum desses filtros isola um processo no
sistema operacional. `untrusted` em `read_file` é metadado no envelope, não
negação de leitura (`src/tools/filesystem.ts:34-45,65-88`).

`terminalTool` não recebe `AbortSignal` nem oferece API de cancelamento; seu
timeout chama `child.kill()` (`src/tools/terminal.ts:76-79,135-159`). Como o
comando controlado não alcançou o processo filho pelo wrapper, **não foi
possível verificar, no caminho do produto, ausência de órfãos após timeout**.
O teste direto de pai/neto delimita a capacidade do addon, sem substituí-la.
Cancelamento de chamada da tool, privilégios de symlink em contas sem essa
capacidade, outros drives, UNC e limites máximos de caminho são
**NOT_MEASURED**. Não há promessa de suporte Windows derivada deste W3.

## Próximos passos delimitados

1. Abrir uma correção separada para a invocação `cmd.exe` de `terminalTool`,
   com reprodução mínima de argv e teste nativo de stdout/stderr, código de
   saída, timeout e árvore de processos. O defeito atual bloqueia esse AC.
2. Corrigir a comparação de contenção de caminho do filtro de workflow com
   `path.relative`/separadores de plataforma e provar caminhos filhos,
   symlinks e drive distinto em Windows nativo. Decidir explicitamente a
   política de `terminal` antes de descrevê-la como isolamento.
3. Ajustar expectativas de testes que interpolam caminho Windows bruto em
   JSON ou exigem modo POSIX `0600`; comparar JSON parseado e medir a
   propriedade de segurança adequada ao Windows. Isso é trabalho de teste,
   separado da correção de execução do terminal.
