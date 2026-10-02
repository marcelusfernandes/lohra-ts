# Recortes de evidência W2

Todos os comandos abaixo foram executados em clones descartáveis do commit `fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`. Os caminhos locais identificam apenas o diretório temporário da medição. Os comandos completos dos gates, horários, exit codes e hashes dos logs integrais estão nos JSONs irmãos.

## Formato/EOL

```text
git config --show-origin --get core.autocrlf
file:C:/Program Files/Git/etc/gitconfig  true

git ls-files --eol package.json src/workflow/service.ts tests/workflow-hardening.test.ts
i/lf    w/crlf  attr/  package.json
i/lf    w/crlf  attr/  src/workflow/service.ts
i/lf    w/crlf  attr/  tests/workflow-hardening.test.ts

node.exe node_modules/prettier/bin/prettier.cjs --check package.json
[warn] package.json
exit 1

node.exe node_modules/prettier/bin/prettier.cjs --end-of-line crlf --check package.json
All matched files use Prettier code style!
exit 0
```

O gate completo `prettier --check .` retornou `Code style issues found in 1135 files` nas duas versões. A amostra `tests/workflow-hardening.test.ts` possuía 792 LF, todos precedidos de CR.

## Subprocesso npm e mutações

```text
node.exe -e "const x=require('node:child_process').spawnSync('npm.cmd',['--version'],{encoding:'utf8'});console.log(JSON.stringify({status:x.status,signal:x.signal,error:x.error&&{code:x.error.code,message:x.error.message}}))"
{"status":null,"signal":null,"error":{"code":"EINVAL","message":"spawnSync npm.cmd EINVAL"}}
```

Essa sonda deu o mesmo resultado com Node 20 e 22. `mutations:all` terminou antes de uma fatia, com stack em `scripts/mutations/all.ts:306`:

```text
Error: spawnSync npm ENOENT
    at realExecute (.../scripts/mutations/all.ts:306:18)
    at runSliceTwice (.../scripts/mutations/all.ts:249:29)
```

## Prova e caminhos

```text
node.exe -e "const p=require('node:path');console.log(JSON.stringify({relative:p.relative('C:/tmp/repo','C:/tmp/repo/tests/workflow-shutdown.test.ts'),declared:'tests/workflow-shutdown.test.ts'}))"
{"relative":"tests\\workflow-shutdown.test.ts","declared":"tests/workflow-shutdown.test.ts"}
```

`npm run prova -- cancel-quiescente` gerou `vitest.json` com 48 assertions executadas em dois arquivos, mas `resumo.json` continha:

```json
{
  "ok": false,
  "total": 48,
  "falhas": [
    {
      "nome": "tests/workflow-shutdown.test.ts did not run",
      "motivo": "arquivo declarado não apareceu no relatório do vitest"
    },
    {
      "nome": "tests/workflow-service-durability.test.ts did not run",
      "motivo": "arquivo declarado não apareceu no relatório do vitest"
    }
  ]
}
```

O recorte JSON omite as duas falhas adicionais `EBUSY` para manter a amostra pequena; `falhas` real contém quatro entradas. O `vitest.json` bruto tinha `tests/workflow-shutdown.test.ts` como `passed` (14 assertions) e `tests/workflow-service-durability.test.ts` como `failed` (34 assertions). Caminho bruto do reporter usa barras `/`; `scripts/prova/vitest-relatorio.ts:45` usa `path.relative()` e o caminho normalizado em Windows contém `\`.

## Suite e filesystem

```text
Node 20: Test Files 81 failed | 237 passed (318)
         Tests 366 failed | 3850 passed (4216)
         Errors 4; Duration 121.37s; exit 1
Node 22: Test Files 81 failed | 237 passed (318)
         Tests 366 failed | 3850 passed (4216)
         Errors 4; Duration 116.59s; exit 1

Exemplo de falha: Error: ENOENT: no such file or directory, lstat '<TEMP>/.../.lohra'
Exemplo de limpeza: Error: EBUSY: resource busy or locked, unlink '<TEMP>/.../state.db'
```

Esses erros são observações do log, não um diagnóstico único para a suíte. A matriz Linux não privilegiada no mesmo SHA passou 4.216/4.216.
