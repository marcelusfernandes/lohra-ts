# #810 — URL do driver no teste do stub

Base `e1eba4e28273979b5defd5917e4396b279d2c3c7`; checkpoint vermelho
compilável `5a53521a83d3dd56fbfe6ba9d5cb306445f933f0`; código verde
`885fa5691f9ea7bd9f35ed71120f87cef0836083`. Dois clones Git padrão,
`F:/lohra-810/node 20 checkout` e `node 22 checkout`, têm **espaços** no
caminho, `npm ci` separado por ABI e `HOME`, `USERPROFILE`, `LOHRA_HOME`,
`CODEX_HOME`, `TEMP`, `TMP`, cache e prefixo npm próprios em F:. Windows 11
x64, Node 20.20.2/npm 10.8.2 e Node 22.23.2/npm 10.9.8. Não se leu home
pessoal nem se usou provider.

Em cada clone, com a ABI correspondente no `PATH`, o foco da base foi:

```text
<NODE.EXE> node_modules/vitest/vitest.mjs run tests/parity/stub-driver.test.ts --maxWorkers=1 --reporter=json --outputFile=<REPORT.JSON>
```

Exit 1, **1 PASS/3 FAIL** em ambos os Nodes. Nas três chamadas, a fonte
original passava `driver.pathname` como terceiro elemento do argv de
`spawnSync(process.execPath, ["--import", tsxLoader, ..., config],
{ cwd: root, encoding: "utf8", timeout: 5000/10000 })`. O teste checa
`result.error` antes de `result.status`; o erro de status veio depois, com
stderr `ERR_MODULE_NOT_FOUND` e status observado 1 (esperado 88 ou 0).
No checkout com espaços, o stderr bruto mostra tanto drive duplicado
(`F:\F:\...`) quanto `%20` no caminho enviado. Os [resultados Node20](node20.json)
e [Node22](node22.json) preservam nomes, status e código de causa, com hashes
SHA-256 dos reporters brutos em F:; o [projetor](project-evidence.mjs) confere
contagens e causas antes de gravar a projeção. Logs e JSON brutos ficam em
`F:/lohra-810/`.

Um probe independente da conversão, no mesmo checkout, obteve
`pathnameExists=false`, `nativeExists=true`, `pathnameEncodesSpace=true` e
`nativeContainsSpace=true` em [Node20](path-node20.json) e
[Node22](path-node22.json). Comando essencial, executado de dentro do clone:

```js
const u = pathToFileURL(join(process.cwd(), "scripts/stub/driver.ts"));
const observed = {
  pathnameExists: existsSync(u.pathname),
  nativeExists: existsSync(fileURLToPath(u)),
  pathnameEncodesSpace: u.pathname.includes("%20"),
  nativeContainsSpace: fileURLToPath(u).includes(" "),
};
```

O checkpoint vermelho adicionou somente a declaração da prova dos **quatro**
casos; typecheck Node22 exit 0 e `npm run prova -- windows-stub-driver-url`
exit 1 por esses três casos. O candidato substituiu somente o caminho no
argv por `fileURLToPath(new URL(...))`. `--import`, config, cwd, encoding,
timeouts, status esperados, verificação de porta livre e assertions de
redirecionamento permaneceram. Foco e prova dos dois Nodes passaram **4/4**,
inclusive o caso de porta ocupada. O quarto caso, que não lança driver,
passava também na base.

Para regerar as projeções a partir dos arquivos brutos:

```text
node docs/investigations/windows/evidence/stub-driver-url/project-evidence.mjs F:/lohra-810 e1eba4e28273979b5defd5917e4396b279d2c3c7 885fa5691f9ea7bd9f35ed71120f87cef0836083
```

Gates canônicos, prova Linux, controle negativo e CI são informados na PR.
Dogfooding real de provider: N/A para diff somente tests/prova/docs.
