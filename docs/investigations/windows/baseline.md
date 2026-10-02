# W1 — baseline nativo de clone e instalação no Windows

Issue [#701](https://github.com/marcelusfernandes/lohra-ts/issues/701). Medição em
2026-10-02, sem WSL, em clones descartáveis do commit
`fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`. Os logs abaixo são recortes
sanitizados dos comandos executados; `<TEMP>` substitui o diretório temporário
do usuário. Nenhuma credencial, banco pessoal ou dependência foi incorporada.

## Ambiente e método

| Item              | Valor observado                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sistema           | Windows 11 Pro, versão 10.0.26200, build 26200, 64 bits                                                                                                |
| Arquitetura       | `AMD64` / `win32-x64`                                                                                                                                  |
| Shell             | PowerShell 7.6.5                                                                                                                                       |
| Git               | 2.47.1.windows.1                                                                                                                                       |
| Node preexistente | 22.23.2, npm 10.9.8; não usado na matriz de instalação                                                                                                 |
| Node da matriz    | ZIPs oficiais portáteis 20.20.2/npm 10.8.2 e 22.23.3/npm 10.9.9, com SHA-256 conferido contra `SHASUMS256.txt` da mesma versão                         |
| Toolchain no PATH | `make`, `g++`, `cl`, `msbuild` ausentes; `python` e `python3` resolvem para aliases de WindowsApps, sem prova de interpretador instalado               |
| Isolamento        | Cada Node teve clone, `HOME`, `USERPROFILE`, `npm_config_cache` e `npm_config_prefix` próprios sob `<TEMP>/lohra-w701`; nenhum npm global foi alterado |

Os runtimes vieram de `https://nodejs.org/dist/v20.20.2/` e
`https://nodejs.org/dist/v22.23.3/`. Os SHA-256 conferidos dos ZIPs
`node-v20.20.2-win-x64.zip` e `node-v22.23.3-win-x64.zip` são,
respectivamente,
`dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77`
e `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71`.
Comandos e conferência: [runtimes.txt](evidence/baseline/runtimes.txt).

## Resultados

| Etapa                                 | Node 20                                                             | Node 22                         | Classificação                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `git clone` padrão                    | Falhou, exit 128                                                    | Falhou antes da escolha do Node | **FAILED — checkout:** `invalid path 'src/agent/aux.ts'`; objetos baixados, árvore não materializada               |
| `git -c core.protectNTFS=false clone` | Passou, exit 0                                                      | Passou, exit 0                  | **PASSED com contorno explícito:** mesmo SHA, `aux.ts` presente e status limpo                                     |
| `npm ci` no clone contornado          | Passou, exit 0; 177 pacotes                                         | Passou, exit 0; 177 pacotes     | **PASSED instalação**, com aviso de `prepare` abaixo                                                               |
| `better-sqlite3`                      | SQLite `:memory:`, `SELECT 42`, exit 0                              | Mesmo resultado, exit 0         | **PASSED — addon carregado e operação real**                                                                       |
| `node-pty`                            | Spawn nativo de `cmd.exe /c echo pty-ok`, saída reconhecida, exit 0 | Mesmo resultado, exit 0         | **PASSED — addon carregado e PTY real**                                                                            |
| Origem dos addons                     | `.node` presentes; `build/config.gypi` ausente                      | Mesmo resultado                 | **PASSED quanto à sonda de artefato:** instalação usou binários distribuídos, sem marcador de `node-gyp configure` |

Evidências: [clone.txt](evidence/baseline/clone.txt),
[node20.txt](evidence/baseline/node20.txt) e
[node22.txt](evidence/baseline/node22.txt). Os clones da instalação foram
independentes; a falha de clone padrão não foi sobrescrita nem reparada.

Em ambos os `npm ci`, `scripts/prepare.mjs` imprimiu
`instalar-git-hooks.sh falhou (exit null)` e
`lefthook install pre-commit falhou (exit null)`, embora o processo `npm ci`
tenha terminado em **0**. Portanto a instalação e o carregamento dos addons
passaram, mas **a instalação dos hooks não foi validada**. A causa dos exits
`null` não foi investigada nesta issue; a hipótese é uma limitação de spawn de
scripts Unix neste ambiente Windows, não uma conclusão de causa raiz.

`node-pty` no Windows distribui `prebuilds/win32-x64/conpty.node`; não há
`prebuilds/win32-x64/pty.node` neste pacote. A sonda acima usa a API do módulo
e o PTY real. O `scripts/pack-check.ts` atual procura `pty.node` para todas as
plataformas; portanto um eventual erro desse check no Windows deve ser
classificado separadamente do carregamento real do addon. Não alterei o
script nesta investigação.

## Fronteira da conclusão e próximos passos

O clone padrão permanece **FAILED**. `core.protectNTFS=false` é um contorno
local de checkout, não prova de suporte Windows do projeto. Com o contorno,
a instalação do pacote de desenvolvimento e os dois addons passaram em
Windows 11 x64 com Node 20 e 22. Windows ARM64, outras versões de Windows ou
Node, o tarball como consumidor e a suíte completa são **NOT_MEASURED nesta
issue**. As outras frentes da milestone devem usar clones separados com o
contorno declarado e manter a falha de checkout como pré-requisito em aberto.

Para avançar rumo a suporte, são necessárias issues próprias para resolver o
nome reservado `aux.ts`, investigar os hooks no Windows e adaptar/verificar o
check de prebuild que hoje espera `pty.node`. Nenhuma correção de produção foi
feita aqui. Os gates canônicos da branch documental dependem de instalação
local no worktree; esta medição rodou `npm ci` apenas em clones descartáveis.
