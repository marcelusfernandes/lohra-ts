# Fonte das sondas #813

Execute `node probe.mjs <20|22> <rpc|raw> <setup|assertion|cleanup>` com clones ABI independentes em `F:/lohra-m25-813`. O script deriva uma cópia do arquivo real dentro do clone, executa apenas o caso selecionado com Vitest e arquiva a cópia fora do repositório. Cada execução exige exit 1, sentinelas primária e de cleanup (quando aplicável), ausência de EBUSY e TEMP exclusivo vazio. Na sonda raw cleanup, a porta é religada após `server.close()` antes da falha induzida.

```javascript
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [version, family, scenario] = process.argv.slice(2);
if (
  !["20", "22"].includes(version) ||
  !["rpc", "raw"].includes(family) ||
  !["setup", "assertion", "cleanup"].includes(scenario)
) {
  throw new Error("usage: node probe.mjs 20|22 rpc|raw setup|assertion|cleanup");
}
const base = "F:/lohra-m25-813";
const clone = join(base, `node${version}`);
const source = join(
  clone,
  "tests/gateway",
  family === "rpc" ? "rpc-dispatch.test.ts" : "raw-socket-primitives.test.ts",
);
const target = join(clone, "tests/gateway", `${family}-fixture-probe.test.ts`);
const archived = join(base, `probe-source-${version}-${family}-${scenario}.ts`);
const report = join(base, `probe-${version}-${family}-${scenario}.json`);
const log = join(base, `probe-${version}-${family}-${scenario}.log`);
const temp = join(base, `probe-temp-${version}-${family}-${scenario}`);
mkdirSync(temp, { recursive: true });
if (readdirSync(temp).length !== 0) throw new Error(`probe temp not empty before run: ${temp}`);
const node =
  version === "20"
    ? "F:/lohra-m25-761-runtime/node-v20.20.2-win-x64/node.exe"
    : "C:/Program Files/nodejs/node.exe";
const nodeDir =
  version === "20" ? "F:/lohra-m25-761-runtime/node-v20.20.2-win-x64" : "C:/Program Files/nodejs";
const first = (value, needle, replacement) => {
  if (!value.includes(needle)) throw new Error(`missing anchor: ${needle}`);
  return value.replace(needle, replacement);
};
let content = readFileSync(source, "utf8");
const register = "  fixture.connection = connection;";
const assertion =
  family === "rpc"
    ? "    const { registry } = setup();"
    : "    const server = await startServer();";
if (scenario === "setup")
  content = first(content, register, `${register}\n  throw new Error('SETUP_SENTINEL_813');`);
if (scenario === "assertion" || scenario === "cleanup")
  content = first(
    content,
    assertion,
    `${assertion}\n    throw new Error('ASSERTION_SENTINEL_813');`,
  );
if (scenario === "cleanup" && family === "rpc") {
  content = first(
    content,
    register,
    "  fixture.connection = { ...connection, close() { connection.close(); throw new Error('DB_CLEANUP_SENTINEL_813'); } };",
  );
}
if (scenario === "cleanup" && family === "raw") {
  content = first(
    content,
    'import { mkdtempSync, rmSync } from "node:fs";',
    'import { mkdtempSync, rmSync } from "node:fs";\nimport { createServer } from "node:net";',
  );
  content = first(
    content,
    "  activeServer = server;",
    `  activeServer = { ...server, async close() {
    await server.close();
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(server.port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    throw new Error('SERVER_CLEANUP_SENTINEL_813_PORT_RELEASED');
  } };`,
  );
}
writeFileSync(target, content);
const isolation = join(base, `isolation-${version}`);
const env = {
  ...process.env,
  PATH: `${nodeDir};${process.env.PATH ?? ""}`,
  HOME: join(isolation, "home"),
  USERPROFILE: join(isolation, "home"),
  LOHRA_HOME: join(isolation, "lohra"),
  CODEX_HOME: join(isolation, "codex"),
  npm_config_cache: join(isolation, "cache"),
  npm_config_prefix: join(isolation, "prefix"),
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
};
try {
  const result = spawnSync(
    node,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      `tests/gateway/${family}-fixture-probe.test.ts`,
      "-t",
      family === "rpc"
        ? "creates a session and asks the caller"
        : "GET /api/status with the correct token",
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: clone, env, encoding: "utf8", timeout: 30_000 },
  );
  writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.error) throw result.error;
  const raw = readFileSync(report, "utf8");
  const json = JSON.parse(raw);
  const messages = json.testResults.flatMap((f) =>
    f.assertionResults.flatMap((a) => a.failureMessages),
  );
  const expected =
    scenario === "setup"
      ? ["SETUP_SENTINEL_813"]
      : scenario === "assertion"
        ? ["ASSERTION_SENTINEL_813"]
        : family === "rpc"
          ? ["ASSERTION_SENTINEL_813", "DB_CLEANUP_SENTINEL_813"]
          : ["ASSERTION_SENTINEL_813", "SERVER_CLEANUP_SENTINEL_813_PORT_RELEASED"];
  const residual = readdirSync(temp);
  const evidence = {
    version,
    family,
    scenario,
    exit: result.status,
    total: json.numTotalTests,
    passed: json.numPassedTests,
    failed: json.numFailedTests,
    expected,
    found: expected.map((x) => messages.some((m) => m.includes(x))),
    ebusy: messages.some((m) => m.includes("EBUSY")),
    residual,
  };
  writeFileSync(
    join(base, `probe-result-${version}-${family}-${scenario}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  if (
    result.status !== 1 ||
    json.numFailedTests !== 1 ||
    evidence.found.some((x) => !x) ||
    evidence.ebusy ||
    residual.length !== 0
  )
    throw new Error(`probe failed: ${JSON.stringify(evidence)}`);
  console.log(JSON.stringify(evidence));
} finally {
  if (existsSync(target)) renameSync(target, archived);
}
```
