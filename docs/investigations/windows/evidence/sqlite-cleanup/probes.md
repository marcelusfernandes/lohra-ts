# Procedimento e fontes das sondas

Todas as alterações abaixo ocorreram **apenas em clones descartáveis**, fora do checkout da issue. SHA histórico: `fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`; SHA atual: `364a78171d8047fa1d23bd7ba635332a32e7b705`. Windows 11 Pro 10.0.26200 x64. Node 20.20.2 e 22.23.2 instalaram `node_modules` separados com `npm ci` (exit 0); o lock histórico tem SHA256 `994AFADC8CFC3BFE04CA2134221737212527688C668CC2803D1DC735B47DA8E6`. No histórico, `prepare` imprimiu falha de instalação dos hooks (`exit null`), sem tornar `npm ci` não zero. O código do teste em ambos os SHAs tem o mesmo blob Git `3ee1e2e592446418edc412f2e1ff919c971a0ed5`.

Antes de executar, definir `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`, `TMP`, `npm_config_cache` e `npm_config_prefix` para pastas privadas de cada clone. No Windows, o checkout histórico requer `git -c core.protectNTFS=false checkout --detach <SHA>` por causa do nome reservado `src/agent/aux.ts`; isso não muda configuração global. Executar cada Node com seus próprios add-ons ABI. Não iniciar provedor.

Corpus W5 (`node` é o Node da linha medida):

```text
node node_modules/vitest/vitest.mjs run tests/workflow-cross-process.test.ts tests/workflow-durability.test.ts tests/workflow-shutdown.test.ts tests/workflow-service-durability.test.ts tests/state-locks.test.ts tests/workflow-steer-tool.test.ts tests/orchestration-child-runner-abort.test.ts --maxWorkers=2
```

Subconjunto mínimo, sem concorrência entre arquivos:

```text
node node_modules/vitest/vitest.mjs run tests/workflow-service-durability.test.ts -t "the leaf dispatch of a launched run|installs one sandbox per ACQUISITION" --maxWorkers=1
```

Para isolar a correção de produto, repetir o corpus em clone do SHA histórico sem tocar no teste, substituindo **somente** `src/workflow/sandbox.ts` pelo conteúdo de `d39b99fddf6be58646d684994faac49e51a60cf9:src/workflow/sandbox.ts`. O arquivo contém a troca de comparação por prefixo com `/` para `relative()`/componentes da plataforma; após a substituição, o corpus passou 89/89 nos dois Nodes. O blob do teste permaneceu igual.

O probe de handle abaixo foi executado no clone atual com `node node_modules/tsx/dist/cli.mjs <probe.mts>`. Ele fez `rmSync` deliberadamente **antes** de `close()` e depois dela, sobre arquivo temporário próprio. [Fonte executada](handle-probe-source.txt); SHA256 da cópia Windows com CRLF: `BED595E50FE941D786AFB3671AA6B748662DA8B5A3FB6191B9545BB047AA1387` (Git normaliza EOL; o bloco abaixo é formatado para leitura).

```ts
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { openStateDatabase } = await import(
  pathToFileURL(join(process.cwd(), "src/state/connection.ts")).href
);
const root = mkdtempSync(join(tmpdir(), "lohra-sqlite-handle-"));
const connection = openStateDatabase(join(root, "state.db"));
let beforeCode = "none";
const openBefore = connection.database.open;
try {
  rmSync(root, { recursive: true, force: true });
} catch (error) {
  beforeCode = error?.code ?? String(error);
}
connection.close();
const openAfter = connection.database.open;
rmSync(root, { recursive: true, force: true });
const removed = !existsSync(root);
console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    openBefore,
    beforeCode,
    openAfter,
    removed,
  }),
);
if (openBefore !== true || beforeCode !== "EBUSY" || openAfter !== false || !removed)
  process.exitCode = 1;
```

Para desmascarar as asserções do SHA histórico, a fonte abaixo alterou somente **duas** cláusulas `finally` do teste em clone temporário; o repositório da issue permaneceu intacto. Em cada bloco acrescentou `if (connection.database.open) connection.close();` antes de `rmSync(root)`. Em Node 20/22 o mesmo subconjunto saiu 1 por asserção de paths, e não por `EBUSY`. [Fonte executada no Node 20](close-probe-source.txt); SHA256 da cópia Windows com CRLF: `C727EF451FE8B0045A4E4F90D795987A9092249620F11F896F2E1378D4C87EEC` (Git normaliza EOL; o bloco abaixo é formatado para leitura). A sonda Node 22 usou a mesma substituição com o caminho do clone fixo em vez de `process.cwd()`; a mudança de path não toca o teste substituído.

```js
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const path = join(process.cwd(), "tests/workflow-service-durability.test.ts");
let source = readFileSync(path, "utf8");
const titles = [
  "the leaf dispatch of a launched run carries the OPERATOR policy, not the spec",
  "installs one sandbox per ACQUISITION and disposes only its own",
];
for (const title of titles) {
  const start = source.indexOf(`it("${title}"`);
  if (start < 0) throw new Error(`missing ${title}`);
  const next = source.indexOf('\n  it("', start + 4);
  const end = next < 0 ? source.length : next;
  const block = source.slice(start, end);
  const needle =
    /(^    \} finally \{\r?\n)(^      rmSync\(root, \{ recursive: true, force: true \}\);)/gm;
  const matches = [...block.matchAll(needle)];
  if (matches.length !== 1)
    throw new Error(`expected one finally cleanup in ${title}, got ${matches.length}`);
  const patched = block.replace(
    needle,
    "$1      if (connection.database.open) connection.close();\n$2",
  );
  source = source.slice(0, start) + patched + source.slice(end);
}
writeFileSync(path, source);
console.log(
  JSON.stringify({
    titles,
    inserted: (source.match(/if \(connection\.database\.open\) connection\.close\(\)/g) ?? [])
      .length,
  }),
);
```

Os logs brutos locais foram reduzidos à [matriz](matrix.json) e às [asserções relevantes](assertions.md), sem paths de usuário. O probe intencional de conexão aberta demonstra a semântica do handle, não prova que toda ocorrência de `EBUSY` no produto tenha a mesma origem.
