# #809 — expectativas nativas de caminho e terminal

## Escopo e ambiente

Base `0ab8ee524482612839264fe98f54c0c0bf93c4e7`; checkpoint vermelho
`d8128cb99cc7107c5fb163d0f5a74fed7f1ef2d3`; código verde
`2b160caaabeeae77208455d17e458340298a8d97`. A prova declara os dois
arquivos completos, que somam 19 testes. Clones Git padrão independentes em
`F:/lohra-809/node20` e `node22`, `npm ci` separado por ABI, com `HOME`,
`USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, cache e prefixo npm
isolados em F:. Windows 11 x64, Node 20.20.2/npm 10.8.2 e Node 22.23.2/npm
10.9.8. Não se consultou home nem credenciais pessoais.

Para reproduzir o focal, em cada clone, com a ABI correspondente no `PATH`:

```text
<NODE.EXE> node_modules/vitest/vitest.mjs run tests/state-schema.test.ts tests/gateway/tools.test.ts --maxWorkers=1 --reporter=json --outputFile=<REPORT.JSON>
```

O comando acima na base teve exit 1, 17 PASS/2 FAIL em ambos os Nodes. As
assinaturas em [Node20](node20.json) e [Node22](node22.json) separam o default
Windows `lohra` com separadores nativos da expectativa POSIX `.lohra`, e
`T12_TERMINAL_CANARY\r\n` do LF esperado. O checkpoint vermelho acrescentou
somente a declaração da prova; typecheck Node22 exit 0 e
`npm run prova -- windows-native-expectations` exit 1 por esses dois casos.

O candidato foi copiado apenas nos dois arquivos de testes para os mesmos
clones. O focal passou 19/19 em ambos. A prova passou 19/19 em Node20 e em
Node22 isolado. Uma primeira execução de prova Node22, em paralelo com a
prova Node20, falhou por timeout de 5 s no caso do terminal (`STACK_TRACE_ERROR`,
exit 1); o focal anterior e a repetição isolada passaram. Concorrência é o
contexto observado, **não uma causa demonstrada** do timeout. O log inicial
`F:/lohra-809/prova22.log` e o final `prova22-isolated.log` foram preservados;
o reporter inicial foi sobrescrito pela repetição, então não é alegado como
evidência preservada. Os SHA-256 dos logs são respectivamente
`A9F4493069CB316089C31BA0E0EACBAFAAF475F357B7AE51A7F617EE63F72D2E` e
`B5EA7AE7E79D93BB1C7C83D37F1051271012813D1A40CBFE952F0AEE19A7AEA7`.
Não se alterou o timeout do teste.

O teste de caminhos fornece `HOME` e `LOCALAPPDATA` distintos: verifica
default por plataforma, fallback a `HOME` sem `LOCALAPPDATA`, profile no
default, precedência de `LOHRA_HOME` e profile sob o override. O esperado é
construído de literais da fixture com `node:path.join`, sem consultar a função
testada para derivá-lo. O teste do terminal mantém despacho real, `ok`, código
zero e stdout **inteiro** igual a canário + terminador (`CRLF` Windows, `LF`
POSIX); as verificações de negação perigosa e demais casos não mudaram.

Os JSONs projetados preservam contagens, mensagens primárias sanitizadas e
SHA-256 dos reporters brutos; [a fonte](project-evidence.mjs) valida 19 testes,
2 falhas na base e 0 no candidato antes de gravá-los. Os reporters/logs brutos
ficam em `F:/lohra-809/`. Comando do projetor:

```text
node docs/investigations/windows/evidence/native-expectations/project-evidence.mjs F:/lohra-809 0ab8ee524482612839264fe98f54c0c0bf93c4e7 2b160caaabeeae77208455d17e458340298a8d97
```

Gates canônicos, prova Linux, controle negativo e CI são informados na PR.
Dogfooding de provider real: N/A para diff somente tests/prova/docs.
