# Sonda reproduzível da fixture prompt.submit

Este driver foi executado fora do repositório em clones ABI próprios Node 20 e 22. Os diretórios F:/lohra-m25-814 e os executáveis Node são caminhos de medição; para reproduzir, substitua essas constantes por caminhos locais equivalentes e instale dependências separadas em cada clone. O driver gera arquivos de teste temporários no clone, executa Vitest com reporter JSON e os move para o diretório de evidências ao terminar. Use clones descartáveis; não execute no checkout principal.

<!-- prettier-ignore -->
```js
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [version, scenario] = process.argv.slice(2);
if (!["20", "22"].includes(version) || !["setup", "assertion", "server-cleanup", "db-cleanup"].includes(scenario)) {
  throw new Error("usage: node probe.mjs 20|22 setup|assertion|server-cleanup|db-cleanup");
}
const base = "F:/lohra-m25-814";
const clone = join(base, `node${version}`);
const originalTest = join(clone, "tests/gateway/prompt-submit.test.ts");
const originalFixture = join(clone, "tests/gateway/prompt-submit.fixture.ts");
const testTarget = join(clone, "tests/gateway/prompt-submit-probe.test.ts");
const fixtureTarget = join(clone, "tests/gateway/prompt-submit-probe.fixture.ts");
const archiveTest = join(base, `probe-source-${version}-${scenario}.test.ts`);
const archiveFixture = join(base, `probe-source-${version}-${scenario}.fixture.ts`);
const report = join(base, `probe-${version}-${scenario}.json`);
const log = join(base, `probe-${version}-${scenario}.log`);
const temp = join(base, `probe-temp-${version}-${scenario}`);
mkdirSync(temp, { recursive: true });
if (readdirSync(temp).length !== 0) throw new Error(`probe temp not empty before run: ${temp}`);
const node = version === "20" ? "F:/lohra-m25-761-runtime/node-v20.20.2-win-x64/node.exe" : "C:/Program Files/nodejs/node.exe";
const nodeDir = version === "20" ? "F:/lohra-m25-761-runtime/node-v20.20.2-win-x64" : "C:/Program Files/nodejs";
const replaceOnce = (value, needle, replacement) => {
  if (!value.includes(needle)) throw new Error(`missing probe anchor: ${needle}`);
  return value.replace(needle, replacement);
};
let test = replaceOnce(readFileSync(originalTest, "utf8"), '"./prompt-submit.fixture.js"', '"./prompt-submit-probe.fixture.js"');
let fixture = readFileSync(originalFixture, "utf8");
const registered = "  fixture.connection = connection;";
const assertion = "    const { server } = await startServer();";
if (scenario === "setup") fixture = replaceOnce(fixture, registered, `${registered}\n  throw new Error('SETUP_SENTINEL_814');`);
if (scenario !== "setup") test = replaceOnce(test, assertion, `${assertion}\n    throw new Error('ASSERTION_SENTINEL_814');`);
if (scenario === "db-cleanup") {
  fixture = replaceOnce(fixture, registered, "  fixture.connection = { ...connection, close() { connection.close(); throw new Error('DB_CLEANUP_SENTINEL_814'); } };");
}
if (scenario === "server-cleanup") {
  fixture = replaceOnce(fixture, 'import { mkdtempSync, rmSync } from "node:fs";', 'import { mkdtempSync, rmSync } from "node:fs";\nimport { createServer } from "node:net";');
  fixture = replaceOnce(fixture, "  activeServer = server;", `  activeServer = { ...server, async close() {
    await server.close();
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(server.port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    throw new Error('SERVER_CLEANUP_SENTINEL_814_PORT_RELEASED');
  } };`);
}
writeFileSync(testTarget, test);
writeFileSync(fixtureTarget, fixture);
const isolation = join(base, `isolation-${version}`);
const env = { ...process.env,
  PATH: `${nodeDir};${process.env.PATH ?? ""}`,
  HOME: join(isolation, "home"), USERPROFILE: join(isolation, "home"),
  LOHRA_HOME: join(isolation, "lohra"), CODEX_HOME: join(isolation, "codex"),
  npm_config_cache: join(isolation, "cache"), npm_config_prefix: join(isolation, "prefix"),
  TEMP: temp, TMP: temp, TMPDIR: temp,
};
try {
  const result = spawnSync(node, ["node_modules/vitest/vitest.mjs", "run", "tests/gateway/prompt-submit-probe.test.ts", "-t", "unknown session_id for a session that was never created", "--maxWorkers=1", "--reporter=json", `--outputFile=${report}`], { cwd: clone, env, encoding: "utf8", timeout: 30_000 });
  writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.error) throw result.error;
  const json = JSON.parse(readFileSync(report, "utf8"));
  const messages = json.testResults.flatMap((file) => file.assertionResults.flatMap((assertion) => assertion.failureMessages));
  const expected = scenario === "setup" ? ["SETUP_SENTINEL_814"] : scenario === "assertion" ? ["ASSERTION_SENTINEL_814"] : scenario === "db-cleanup" ? ["ASSERTION_SENTINEL_814", "DB_CLEANUP_SENTINEL_814"] : ["ASSERTION_SENTINEL_814", "SERVER_CLEANUP_SENTINEL_814_PORT_RELEASED"];
  const residual = readdirSync(temp);
  const evidence = { version, scenario, exit: result.status, total: json.numTotalTests, passed: json.numPassedTests, failed: json.numFailedTests, expected, found: expected.map((x) => messages.some((m) => m.includes(x))), ebusy: messages.some((m) => m.includes("EBUSY")), residual };
  writeFileSync(join(base, `probe-result-${version}-${scenario}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  if (result.status !== 1 || json.numFailedTests !== 1 || evidence.found.some((x) => !x) || evidence.ebusy || residual.length !== 0) throw new Error(`probe failed: ${JSON.stringify(evidence)}`);
  console.log(JSON.stringify(evidence));
} finally {
  if (existsSync(testTarget)) renameSync(testTarget, archiveTest);
  if (existsSync(fixtureTarget)) renameSync(fixtureTarget, archiveFixture);
}
```
