# W7 — tarball e consumidor nativo no Windows

Investigação da issue [#707](https://github.com/marcelusfernandes/lohra-ts/issues/707),
em 2026-10-02. Dois clones descartáveis no Windows 11 Pro x64 partiram do SHA
`fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`, um por ABI de Node. O clone
exigiu o contorno `git -c core.protectNTFS=false clone` já registrado em W1
([#701](https://github.com/marcelusfernandes/lohra-ts/issues/701)); isso não
altera o resultado de clone padrão. Node 20.20.2/npm 10.8.2 e Node
22.23.3/npm 10.9.9 vieram dos ZIPs oficiais com SHA-256 conferido em W1.

## Método

Cada clone teve `npm ci`, `npm run build` e `npm pack` próprios. Cada tarball
foi instalado com `npm install --prefix <TEMP>/lohra-w707/consumer-<versão>
<tarball>` em consumidor sem `.git`, com `HOME`, `USERPROFILE`, `LOHRA_HOME`,
`CODEX_HOME`, cache e prefixo npm temporários. O diretório do Node portátil
vinha primeiro no `PATH`. O `npm pack` usou `LOHRA_SKIP_PREPARE=1`, como o
workflow de release. Não houve instalação global, publicação nem atualização
mutável. Logs e caminhos pessoais foram sanitizados com `<TEMP>`.

A primeira tentativa exploratória de `doctor` teve apenas `HOME` e
`USERPROFILE` temporários; o runtime escolheu seu home padrão. O log dessa
tentativa foi imediatamente descartado e sobrescrito fora do repositório.
Nenhum dado dela entrou nesta evidência. Todas as sondas válidas de CLI
definiram `LOHRA_HOME` e `CODEX_HOME` temporários; `doctor` confirmou o home
isolado. Esse detalhe é pré-requisito para reproduzir o estudo sem ler estado
do usuário.

## Matriz observada

| Etapa                                         | Node 20                                        | Node 22                                             | Veredito                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` e `npm run build` no clone           | 0 / 0                                          | 0 / 0                                               | **PASSED**; `dist/cli.js` criado nos dois                                                                                                                                 |
| `npm pack`                                    | 0                                              | 0                                                   | **PASSED**; mesmo tarball de 842.820 bytes e SHA-256 `0cd55204309984263eb06ee860b36c41ad7ce71b42076642965b55ce98246f3f`                                                   |
| Instalação com `--prefix` temporário          | 0                                              | 0                                                   | **PASSED**; shims `lohra`, `lohra.cmd` e `lohra.ps1` presentes                                                                                                            |
| `lohra.ps1 --version` e `lohra.cmd --version` | 0 / 0, `lohra 0.0.13`                          | 0 / 0, mesma saída                                  | **PASSED** nos dois shells                                                                                                                                                |
| `lohra.ps1 doctor --json`                     | 2                                              | 2                                                   | **PASSED como diagnóstico**: envelope JSON válido, `ok: false`, `platform: win32`, home isolado confirmado; faltam provedores/credenciais nesse home vazio                |
| Addons do pacote instalado                    | SQLite 42; PTY `cmd.exe` exit 0                | Mesmo resultado                                     | **PASSED**: `better-sqlite3` e `node-pty` reais resolvidos a partir do pacote consumidor                                                                                  |
| `lohra.ps1 update --check`, sem `.git`        | 0, versão atual                                | 0, versão atual                                     | **PASSED** para consulta; nenhuma atualização aplicada                                                                                                                    |
| `import("lohra-ts")`                          | `ERR_MODULE_NOT_FOUND`, exit 1                 | Mesmo resultado                                     | **FAILED — entrada de biblioteca**: `package.json#main` aponta para `dist/index.js`, ausente também no tarball; `types` aponta para `dist/index.d.ts`, igualmente ausente |
| `npm run pack:check`                          | `PACK_COMMAND_FAILED:npm:unknown:null`, exit 1 | `PACK_COMMAND_FAILED:npm:unknown:undefined`, exit 1 | **FAILED — harness:** falha no primeiro `spawnSync("npm", ...)`, antes de examinar o tarball                                                                              |

O consumidor não dependeu do checkout para a execução de CLI ou dos addons.
Porém **a tool `terminal` via um turno de chat da CLI não foi medida**: o
`pack:check`, que exercitaria o turno com stub, parou antes da instalação
interna. A sonda de PTY aqui comprova o addon empacotado e um processo PTY
real, não a integração da tool. `doctor` retornar 2 sem provedor no home
isolado é o diagnóstico esperado do ambiente; não é falha de inicialização
Windows. A consulta `update --check` usou o registry e retornou “up to date”
sem `.git`; permissões de uma atualização mutável são **NOT_MEASURED**.

O erro do `pack:check` foi reproduzido separadamente:
`spawnSync("npm", ["--version"])` devolveu `error.code: "ENOENT"` no Windows
desta máquina, sem status de saída. Isso explica o `unknown` do harness. A
sonda `spawnSync("npm.cmd", ...)` com opções padrão devolveu `EINVAL`, então
trocar apenas o nome do executável não é uma correção demonstrada. Além disso,
o check atual espera `prebuilds/win32-x64/pty.node`, enquanto o `node-pty`
instalado fornece `conpty.node`; como o check parou antes dessa etapa, esta é
uma **segunda incompatibilidade prevista pelo código e pelos artefatos**, não
um erro observado na execução do check. Nenhum script foi alterado.

Evidências: [pacote.txt](evidence/distribution/pacote.txt),
[consumer-node20.txt](evidence/distribution/consumer-node20.txt),
[consumer-node22.txt](evidence/distribution/consumer-node22.txt) e
[pack-check.txt](evidence/distribution/pack-check.txt). CLI e importação de
biblioteca são resultados separados. Para avançar, abrir correções próprias
para a entrada `main`/`types` e para o harness Windows, com regressões no
consumidor; uma sonda posterior deve exercitar a tool `terminal` via CLI.
Este relatório não declara suporte Windows geral.
