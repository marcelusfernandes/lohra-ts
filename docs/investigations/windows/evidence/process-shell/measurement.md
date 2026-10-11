# #812 — shell das bancadas de processo no Windows

Medição em Windows 11 x64, base `51d87cf5f93e7c28ad51a0a4ceb911e5f6d0bf28`, clones descartáveis independentes em `F:` para Node 20.20.2/npm 10.8.2 e Node 22.23.2/npm 10.9.8. Cada clone recebeu `npm ci` (exit 0), com `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `LOHRA_HOME` e `CODEX_HOME` próprios **fora** da árvore Git. O ensaio inicial com `TEMP` dentro dos clones foi descartado: as fixtures temporárias herdavam o `.git` do clone e invalidavam casos que dependem de uma raiz sem Git. Os resultados abaixo vieram de novos clones limpos com isolamento corrigido.

| Corpus original na base         |                Node 20 |                Node 22 |
| ------------------------------- | ---------------------: | ---------------------: |
| `protege-main.test.ts`          |              0/24 PASS |              0/24 PASS |
| `stop-gate.test.ts`             |              1/18 PASS |              1/18 PASS |
| `claude-skills-scripts.test.ts` |              0/12 PASS |              0/12 PASS |
| `protege-escrita.test.ts`       |              0/10 PASS |              0/10 PASS |
| **Total**                       | **1/64 PASS, 63 FAIL** | **1/64 PASS, 63 FAIL** |

Sonda direta em cada Node, no mesmo isolamento: `spawnSync("sh", ["--version"], { encoding: "utf8", timeout: 10000 })` retornou `status: null`, `error.code: ENOENT`; `spawnSync("git", ["--version"], ...)` retornou status 0. Isso identifica uma falha de lançamento da bancada, mas não atribui automaticamente cada uma das 63 assertions à mesma causa.

Depois do commit vermelho compilável `f68e524`, o helper localizou o `sh.exe` relativo ao `git.exe` encontrado no `PATH` do **filho**, sem diretório/drive fixo. Ele chama `spawnSync` com argv e `shell: false`, preserva `cwd`, stdin, stdout, stderr e status, e lança erro com `cause` no erro de spawn. O ambiente do chamador permanece imutável; no Windows a última chave `Path`/`PATH` do objeto prevalece. Testes de execução com caminho contendo espaços, falha `ENOENT`, entrada, saída, cwd e ambiente passaram 5/5 em ambos os Nodes.

O ensaio corrigido com as quatro bancadas originais e os cinco testes do helper passou **68/69** em Node 20 e **68/69** em Node 22. `stop-gate` passou 18/18, `protege-escrita` 10/10, `protege-main` 24/24 e `claude-skills-scripts` 11/12; nenhuma assertion foi removida, pulada ou enfraquecida. O teste de `gh` usa uma cópia temporária de `process.execPath` como `gh.exe` e um preload condicional que registra marcador e sai 1 somente nesse processo; não versiona executável, não invoca o `gh` real e não faz rede. A sonda isolada viu `marker: true` e negação do hook com exit 2.

A falha restante, ID estável `b3c17b6580bbba57` nos dois Nodes, é `tests/claude-skills-scripts.test.ts:99-100`: `statSync(secao.sh).mode & 0o111` resulta 0 no checkout NTFS, embora `git ls-files -s .claude/skills/pr/scripts/secao.sh` registre `100755`. A [#823](https://github.com/marcelusfernandes/lohra-ts/issues/823) acompanha a representação do bit executável. A prova nativa completa permanece **FAIL** por esse caso; execução do shell e aprovação global da bancada são resultados distintos.

Reprodução focal, em cada clone e com os homes/temps isolados fora do clone:

```text
node node_modules/vitest/vitest.mjs run tests/protege-main.test.ts tests/stop-gate.test.ts tests/claude-skills-scripts.test.ts tests/protege-escrita.test.ts --maxWorkers=1 --reporter=json --outputFile=baseline-external.json
node node_modules/vitest/vitest.mjs run tests/process-shell.test.ts tests/protege-main.test.ts tests/stop-gate.test.ts tests/claude-skills-scripts.test.ts tests/protege-escrita.test.ts --maxWorkers=1 --reporter=json --outputFile=focus-third.json
```

O primeiro comando aplica-se aos clones da base; o segundo, aos clones candidatos. A matriz dos cinco gates Linux e dos quatro gates nativos será registrada no corpo da PR no SHA final. Esta evidência não declara suporte Windows global nem altera os hooks.
