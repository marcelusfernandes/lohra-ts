# #815 — fixture de `npm pack --dry-run`

Medição em Windows 11 x64, clones descartáveis separados por ABI, com `HOME`,
`USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, cache e prefixo npm
isolados. Node 20.20.2/npm 10.8.2 e Node 22.23.2/npm 10.9.8. Nenhum pacote
foi publicado; `LOHRA_SKIP_PREPARE=1` suprimiu a instalação de hooks durante
`npm ci` e `pack`.

## Vermelho

Base `74957ea56978ce54185d42fd36a71e0c8f27d684`. O comando diagnóstico
abaixo usou as mesmas opções de lançamento da fixture e acrescentou somente
timeout e limite de saída à sonda. `npm pack` não chegou a produzir JSON:

```js
const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: clone,
  encoding: "utf8",
  env: { ...process.env, LOHRA_SKIP_PREPARE: "1" },
  timeout: 60_000,
  maxBuffer: 16 * 1024 * 1024,
});
console.log({
  status: result.status,
  signal: result.signal,
  error: result.error?.code,
  stderr: result.stderr,
});
```

| ABI     | `status` | `signal` | `error.code` | `stderr`    | Arquivo focal na base                                |
| ------- | -------- | -------- | ------------ | ----------- | ---------------------------------------------------- |
| Node 20 | `null`   | `null`   | `ENOENT`     | `null`      | 2 FAIL, 7 PASS; erro exibido: `exit null: null`      |
| Node 22 | `null`   | `null`   | `ENOENT`     | `undefined` | 2 FAIL, 7 PASS; erro exibido: `exit null: undefined` |

O commit vermelho `b7d15e9e1508cca68fed64f5466a15fdbef5217f` acrescentou um
caso compilável com executável Node inexistente e `npm_execpath` válido.
`typecheck` passou nas duas ABIs; o arquivo focal ficou 3 FAIL/7 PASS nas
duas. O terceiro FAIL exige `ENOENT` observável em `Error.message` e
`Error.cause`, portanto não aceita erro genérico `exit null` ou resultado
vazio. Os outros dois FAIL são as assertions originais da whitelist.

## Verde e limites

O helper existente `runNpmSync` executa `npm-cli.js` com o Node da ABI atual,
`shell: false`, `cwd` da raiz e os argumentos originais. A fixture limita
o processo a 60 segundos e 16 MiB de saída, verifica `result.error` antes do
status e preserva esse erro como `cause`. A extração defensiva do último array
JSON e as assertions de inclusão/exclusão permaneceram. No checkpoint
`4f51f545122e9c0bd78ebb659f0735a7c15ea6df`, o arquivo focal passou
10/10 em Node 20 e 22. O gate `typecheck` depois detectou uma tentativa de
acessar `Error.code` fora da tipagem pública; o ajuste está no SHA
`9b508f837679916418870a69349cf5effb472b67`. Esse SHA falhou em
`format:check` nas três plataformas e não foi contado como validação final.
Após Prettier, os gates finais de código abaixo usam
`d5927e7a78eb6d183a178dec92ff268354f6654b`.

| Ambiente                      | Build | Typecheck | Lint | Format | Suíte                              | Prova | Controle negativo     |
| ----------------------------- | ----- | --------- | ---- | ------ | ---------------------------------- | ----- | --------------------- |
| Node 20 Windows               | PASS  | PASS      | PASS | PASS   | N/A (focal anterior 10/10)         | 10/10 | N/A local             |
| Node 22 Windows               | PASS  | PASS      | PASS | PASS   | N/A (focal anterior 10/10)         | 10/10 | N/A local             |
| Node 22 Linux, usuário `node` | PASS  | PASS      | PASS | PASS   | 338 arquivos, 4.428 PASS + 4 skips | 10/10 | SKIP mecânico, exit 0 |

Nos clones Windows, a sequência executada com o Node e `npm-cli.js` da
respectiva ABI foi `npm ci --no-audit --no-fund`, `npm run build`,
`npm run typecheck`, `npm run lint`, `npm run format:check` e
`npm run prova -- windows-package-fixture-npm`. No clone Linux
`/work/lohra815`, usuário `node` (uid 1000), a mesma sequência incluiu
`npm test -- --maxWorkers=1` antes da prova e
`npm run ci:controle-negativo -- --base 74957ea56978ce54185d42fd36a71e0c8f27d684 --head d5927e7a78eb6d183a178dec92ff268354f6654b --branch test/815-windows-package-fixture-npm`
depois. A suíte Linux levou 162,55 s; o relatório da prova foi
`{"ok":true,"total":10,"falhas":[]}` nas três plataformas. A árvore Git
do clone Linux permaneceu limpa.

O controle negativo de PR somente `tests/**`/`prova/**` usa SKIP mecânico
quando o teste já existente é editado; ele não substitui o vermelho nativo
observado. Dogfooding real: N/A, pois o diff toca apenas testes, declaração
de prova e esta evidência; nenhum `src/**` ou campo de pacote que o runtime
consome foi alterado.

Os commits foram criados com `LEFTHOOK=0` porque o worktree da issue não
tem `node_modules`, e o hook local não encontrava `@eslint/js`. Prettier e
ESLint foram executados no clone ABI 22 com dependências próprias; os gates
completos no SHA final verificam a mesma fonte. O primeiro pedido de commit
falhou também em Prettier; a formatação foi corrigida antes do commit
vermelho. Logs brutos permanecem em área temporária isolada fora do repo.
