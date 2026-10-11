# Fontes das sondas de #752

A sonda foi executada fora do checkout em F:, com chave fictícia e chamadas HTTP somente locais. O script de empacotamento projeta o reporter bruto em JSON sanitizado, com contagens conciliadas. Nenhum deles modifica produto ou teste.

## Processo real `serve`

<!-- prettier-ignore -->
```js
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';

const [root, runHome] = process.argv.slice(2);
if (!root || !runHome) throw new Error('usage: serve-probe.mjs CLONE_ROOT RUN_HOME');
const host = '127.0.0.1';
const portProbe = net.createServer();
await new Promise((ok, fail) => portProbe.once('error', fail).listen(0, host, ok));
const port = portProbe.address().port;
await new Promise((ok, fail) => portProbe.close((error) => error ? fail(error) : ok()));
for (const name of ['home', 'lohra', 'codex', 'temp', 'appdata', 'localappdata']) {
  await mkdir(join(runHome, name), { recursive: true });
}
const env = {
  HOME: join(runHome, 'home'),
  USERPROFILE: join(runHome, 'home'),
  LOHRA_HOME: join(runHome, 'lohra'),
  CODEX_HOME: join(runHome, 'codex'),
  TEMP: join(runHome, 'temp'),
  TMP: join(runHome, 'temp'),
  APPDATA: join(runHome, 'appdata'),
  LOCALAPPDATA: join(runHome, 'localappdata'),
  LOHRA_PROVIDER: 'openai',
  OPENAI_API_KEY: 'T11-DUMMY-KEY-NO-LIVE-EGRESS',
  PATH: '/usr/bin:/bin',
  NO_COLOR: '1',
  TZ: 'UTC',
};
const child = spawn(process.execPath,
  ['--import', 'tsx', resolve(root, 'src/cli.ts'), 'serve', '--host', host,
   '--port', String(port), '--insecure', '--tools', 'read_file'],
  { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
let exit = null;
let spawnError = null;
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-16384); });
child.once('error', (error) => { spawnError = { code: error.code ?? null, message: error.message }; });
child.once('close', (code, signal) => { exit = { code, signal }; });
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
let stage = 'ready';
let status = null;
let listShape = false;
let killReturned = null;
let portRebind = false;
let timedOut = false;
const started = Date.now();
try {
  while (!stderr.includes('Lohra OpenAI server:') && exit === null && Date.now() - started < 10000) await pause(20);
  if (!stderr.includes('Lohra OpenAI server:')) throw new Error('SERVER_NOT_READY');
  stage = 'get-models';
  const response = await fetch(`http://${host}:${port}/v1/models`, {
    headers: { connection: 'close' }, signal: AbortSignal.timeout(2000),
  });
  status = response.status;
  listShape = (await response.text()).includes('"object":"list"');
  stage = 'signal';
  killReturned = child.kill('SIGINT');
  const waitStarted = Date.now();
  while (exit === null && Date.now() - waitStarted < 8000) await pause(20);
  if (exit === null) { timedOut = true; throw new Error('PROCESS_CLOSE_TIMEOUT'); }
  stage = 'port-rebind';
  const rebound = net.createServer();
  await new Promise((ok, fail) => rebound.once('error', fail).listen(port, host, ok));
  await new Promise((ok, fail) => rebound.close((error) => error ? fail(error) : ok()));
  portRebind = true;
  stage = 'complete';
} catch (error) {
  stage = `${stage}:${error instanceof Error ? error.message : String(error)}`;
} finally {
  if (exit === null) {
    child.kill('SIGKILL');
    const deadline = Date.now() + 2000;
    while (exit === null && Date.now() < deadline) await pause(20);
  }
}
const result = {
  node: process.version, platform: process.platform, stage, status, listShape,
  warningTools: stderr.includes('agentic mode — server-side tools enabled: read_file'),
  warningInsecure: stderr.includes('--insecure with tools = UNAUTHENTICATED remote code execution'),
  printedApiKey: stderr.includes('API key:'), killReturned, exit, portRebind,
  timedOut, spawnError, elapsedMs: Date.now() - started,
};
console.log(JSON.stringify(result));
if (stage !== 'complete' || status !== 200 || !listShape || !portRebind) process.exitCode = 1;
```

## Projetor dos resultados

<!-- prettier-ignore -->
```js
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [rawDir, outputDir] = process.argv.slice(2);
if (!rawDir || !outputDir) throw new Error('usage: pack-evidence.mjs RAW_DIR OUTPUT_DIR');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const write = (name, value) => writeFileSync(join(outputDir, name), JSON.stringify(value, null, 2) + '\n');
for (const label of ['node20', 'node22']) {
  const rawPath = join(rawDir, `focal-${label}.json`);
  const raw = readFileSync(rawPath);
  const report = JSON.parse(raw.toString('utf8'));
  const files = report.testResults.map((file) => {
    const relative = `tests/${basename(file.name)}`;
    return {
      file: relative,
      status: file.status,
      tests: file.assertionResults.map((assertion) => ({
        id: sha256(`${relative}\u0000${assertion.fullName}`).slice(0, 16),
        test: assertion.fullName,
        status: assertion.status,
        primary: assertion.failureMessages[0]?.split(/\r?\n/, 1)[0] ?? null,
        secondaryCount: Math.max(0, assertion.failureMessages.length - 1),
      })),
    };
  });
  const observed = files.flatMap((file) => file.tests);
  const counts = {
    total: observed.length,
    passed: observed.filter((item) => item.status === 'passed').length,
    failed: observed.filter((item) => item.status === 'failed').length,
    pending: observed.filter((item) => item.status === 'pending').length,
  };
  const reconciliation = {
    total: counts.total === report.numTotalTests,
    passed: counts.passed === report.numPassedTests,
    failed: counts.failed === report.numFailedTests,
    pending: counts.pending === report.numPendingTests,
    files: files.length === report.testResults.length,
  };
  if (Object.values(reconciliation).some((value) => !value)) throw new Error(`${label} count mismatch`);
  write(`focused-${label}.json`, {
    schema: 1,
    measuredSha: '4850b36079620f30f0d51621219f0e5fb4e646d2',
    node: label === 'node20' ? '20.20.2' : '22.23.2',
    status: 'FAIL',
    exit: 1,
    rawReporterSha256: sha256(raw),
    rawLogSha256: sha256(readFileSync(join(rawDir, `focal-${label}.log`))),
    counts,
    fileResults: files.length,
    reconciliation,
    files,
  });
  const serveRaw = readFileSync(join(rawDir, `serve-probe-${label}.raw.log`));
  const serve = JSON.parse(serveRaw.toString('utf8'));
  if (serve.spawnError !== null) throw new Error(`${label} spawn failed`);
  write(`serve-${label}.json`, {
    schema: 1,
    measuredSha: '4850b36079620f30f0d51621219f0e5fb4e646d2',
    probeStatus: 'PASS_DIAGNOSTIC',
    commandExit: 0,
    rawLogSha256: sha256(serveRaw),
    ...serve,
  });
}
```
