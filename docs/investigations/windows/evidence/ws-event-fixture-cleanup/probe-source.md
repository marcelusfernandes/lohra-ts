# Fonte da sonda de #827

Driver executado em clones ABI separados. Ajuste os caminhos constantes de F e dos executáveis Node para reproduzir; gere os clones e instale dependências próprias antes da execução. O script cria cópia temporária de um teste no clone, executa Vitest com JSON e move a cópia para evidências externas após o término.

<!-- prettier-ignore -->
```js
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [version, fixtureName, scenario] = process.argv.slice(2);
if (
  !["20", "22"].includes(version) ||
  !["notices", "compaction"].includes(fixtureName) ||
  !["setup", "assertion", "server-cleanup", "db-cleanup"].includes(scenario)
) {
  throw new Error("usage: probe.mjs 20|22 notices|compaction setup|assertion|server-cleanup|db-cleanup");
}

const base = "F:/lohra-m25-827";
const clone = join(base, `node${version}`);
const relative =
  fixtureName === "notices"
    ? "tests/gateway/ws-connection-notices.test.ts"
    : "tests/gateway-compaction-events.test.ts";
const probeRelative = relative.replace(".test.ts", "-probe.test.ts");
const original = join(clone, relative);
const target = join(clone, probeRelative);
const label = `${version}-${fixtureName}-${scenario}`;
const archived = join(base, `probe-source-${label}.test.ts`);
const temp = join(base, `probe-temp-${label}`);
const report = join(base, `probe-${label}.json`);
const marker = join(base, `probe-port-${label}.txt`);
mkdirSync(temp, { recursive: true });
if (readdirSync(temp).length !== 0) throw new Error(`temp not empty: ${temp}`);
if (existsSync(marker)) throw new Error(`marker already exists: ${marker}`);

const replaceOnce = (source, needle, replacement) => {
  if (!source.includes(needle)) throw new Error(`missing anchor: ${needle}`);
  return source.replace(needle, replacement);
};
let source = readFileSync(original, "utf8");
const setupAnchor = "  fixture.connection = connection;";
if (scenario === "setup") {
  source = replaceOnce(source, setupAnchor, `${setupAnchor}\n  throw new Error('SETUP_SENTINEL_827');`);
} else if (scenario === "db-cleanup") {
  source = replaceOnce(
    source,
    setupAnchor,
    "  fixture.connection = { ...connection, close() { connection.close(); throw new Error('DB_CLEANUP_SENTINEL_827'); } };",
  );
}

if (scenario !== "setup") {
  const assertionAnchor =
    fixtureName === "notices"
      ? "    const { ws, sessionId } = await connectAndCreateSession(server);"
      : "    await nextMessage(ws); // gateway.ready";
  source = replaceOnce(
    source,
    assertionAnchor,
    `${assertionAnchor}\n    throw new Error('ASSERTION_SENTINEL_827');`,
  );
  source = replaceOnce(
    source,
    'import { mkdtempSync, rmSync } from "node:fs";',
    'import { mkdtempSync, rmSync, writeFileSync } from "node:fs";\nimport { createServer } from "node:net";',
  );
  source = replaceOnce(
    source,
    "      await server.close();",
    `      await server.close();
      const rebound = createServer();
      await new Promise<void>((resolve, reject) => {
        rebound.once("error", reject);
        rebound.listen(server.port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve, reject) => rebound.close((error) => error ? reject(error) : resolve()));
      writeFileSync(process.env.LOHRA_PROBE_PORT_MARKER as string, "PORT_REBOUND_827");
      ${scenario === "server-cleanup" ? "throw new Error('SERVER_CLEANUP_SENTINEL_827');" : ""}`,
  );
}

writeFileSync(target, source);
const isolation = join(base, `isolation-${version}`);
const node =
  version === "20"
    ? "F:/lohra-m25-761-runtime/node-v20.20.2-win-x64/node.exe"
    : "C:/Program Files/nodejs/node.exe";
const env = {
  ...process.env,
  PATH: `${join(node, "..")};${process.env.PATH ?? ""}`,
  HOME: join(isolation, "home"),
  USERPROFILE: join(isolation, "home"),
  LOHRA_HOME: join(isolation, "lohra"),
  CODEX_HOME: join(isolation, "codex"),
  npm_config_cache: join(isolation, "cache"),
  npm_config_prefix: join(isolation, "prefix"),
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
  LOHRA_PROBE_PORT_MARKER: marker,
};
const focus =
  fixtureName === "notices"
    ? "attaches the claimed overlay"
    : "compaction.unsupported";
try {
  const result = spawnSync(
    node,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      probeRelative,
      "-t",
      focus,
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: clone, env, encoding: "utf8", timeout: 30_000 },
  );
  writeFileSync(join(base, `probe-${label}.log`), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.error) throw result.error;
  const json = JSON.parse(readFileSync(report, "utf8"));
  const messages = json.testResults.flatMap((file) =>
    file.assertionResults.flatMap((assertion) => assertion.failureMessages),
  );
  const expected =
    scenario === "setup"
      ? ["SETUP_SENTINEL_827"]
      : scenario === "server-cleanup"
        ? ["ASSERTION_SENTINEL_827", "SERVER_CLEANUP_SENTINEL_827"]
        : scenario === "db-cleanup"
          ? ["ASSERTION_SENTINEL_827", "DB_CLEANUP_SENTINEL_827"]
          : ["ASSERTION_SENTINEL_827"];
  const evidence = {
    version,
    fixtureName,
    scenario,
    exit: result.status,
    total: json.numTotalTests,
    failed: json.numFailedTests,
    expected,
    found: expected.map((sentinel) => messages.some((message) => message.includes(sentinel))),
    portRebound: scenario === "setup" ? null : existsSync(marker) && readFileSync(marker, "utf8") === "PORT_REBOUND_827",
    ebusy: messages.some((message) => message.includes("EBUSY")),
    residual: readdirSync(temp),
  };
  writeFileSync(join(base, `probe-result-${label}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  if (
    result.status !== 1 ||
    json.numFailedTests !== 1 ||
    evidence.found.some((found) => !found) ||
    evidence.portRebound === false ||
    evidence.ebusy ||
    evidence.residual.length !== 0
  ) {
    throw new Error(`probe failed: ${JSON.stringify(evidence)}`);
  }
  console.log(JSON.stringify(evidence));
} finally {
  if (existsSync(target)) renameSync(target, archived);
}
```
