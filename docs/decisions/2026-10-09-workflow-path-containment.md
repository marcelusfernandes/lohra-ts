# Contenção de caminhos no workflow

- **Data:** 2026-10-09
- **Origem:** issue #723, investigação Windows #700 e regressão de checkout
  Windows em `tests/workflow-sandbox.test.ts`.

## Contexto

`sandboxDispatch` examina `read_file` e `write_file` antes de chamar a tool
(`src/workflow/sandbox.ts:59-60,169-191`). A comparação anterior acrescentava
`/` ao root real: em Windows, onde `realpathSync` devolve `\`, filhos legítimos
eram recusados. O wrapper também trata `web_fetch`/`web_search` e mantém a
recusa de egress e de filesystem em runs tainted.

## Decisão

- A contenção de `read_file` e `write_file` usa caminhos reais e a comparação
  de componentes da plataforma (`src/workflow/sandbox.ts:63-117`). O root e
  filhos são aceitos; irmãos, prefixos parecidos, outro drive e symlinks que
  escapam são recusados. Caminho para arquivo ainda não criado resolve o
  ancestral existente mais próximo, para cobrir symlink no meio do caminho.
  Um symlink cujo alvo ainda não existe é recusado: `lstat` detecta o link e
  a falha de `realpath` impede autorização pelo nome lexical.
  Caminhos brutos com componente `..` são recusados antes de `resolve`:
  em POSIX, `link/../arquivo` pode atravessar o link antes de subir ao pai,
  embora a normalização lexical tenha apagado `link`.
- O resultado da política é uma autorização **no dispatch dessas duas tools**.
  `terminal` não está em `FS_TOOLS` (`src/workflow/sandbox.ts:59,179`) e não é
  confinado por esta checagem. O processo filho tampouco recebe um sandbox do
  sistema operacional por causa desta política. Não apresentar `fs_allow` como
  isolamento de qualquer comando executado em terminal.
- O tratamento de egress permanece separado: run tainted recusa
  `web_fetch`/`web_search`; `web_fetch` fora da allowlist de host é recusado
  (`src/workflow/sandbox.ts:152-189`). Esta mudança não amplia essa lista.

## Doutrina para autores de spec

Use `read_file`/`write_file` quando a contenção de paths do workflow for parte
do contrato. Se uma tarefa requer execução de comandos, trate a tool `terminal`
como capacidade distinta e não pressuponha confinamento de filesystem ou rede
por `fs_allow`/`egress_allow`.

## Evidência

- `tests/workflow-sandbox.test.ts`: raiz, filho, irmão, prefixo, drive distinto
  e escape por symlink, inclusive alvo inexistente e travessia `link/..` com
  `write_file` real; os testes preexistentes de egress seguem exigindo recusa
  fora da allowlist.
- `npm run prova -- windows-workflow-root` declara os testes de sandbox e de
  recusas em `prova/windows-workflow-root.ts`.
