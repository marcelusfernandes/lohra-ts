// Run only in a disposable clone marked with .lohra-disposable-probe.
// The source file is restored after the child run, even when Vitest fails.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [cloneArgument, scenario, evidenceArgument] = process.argv.slice(2);
if (!cloneArgument || !scenario || !evidenceArgument) {
  throw new Error(
    "usage: node probe.mjs <marked-disposable-clone> <assertion|setup> <evidence-dir>",
  );
}
const cloneRoot = resolve(cloneArgument);
const evidenceRoot = resolve(evidenceArgument);
if (!existsSync(join(cloneRoot, ".lohra-disposable-probe"))) {
  throw new Error("refusing to modify an unmarked checkout");
}
const variants = {
  assertion: {
    old: 'expect(ready.params.type).toBe("gateway.ready");',
    replacement: 'expect(ready.params.type).toBe("PROBE_WRONG_GATEWAY_READY");',
    marker: "PROBE_WRONG_GATEWAY_READY",
  },
  setup: {
    old: "connections.push(connection);",
    replacement: 'connections.push(connection); throw new Error("PROBE_SETUP_FAILURE");',
    marker: "PROBE_SETUP_FAILURE",
  },
};
const selected = variants[scenario];
if (!selected) throw new Error(`unknown scenario: ${scenario}`);
const testPath = join(cloneRoot, "tests", "gateway", "ws-connection.test.ts");
const source = readFileSync(testPath, "utf8");
if (source.split(selected.old).length !== 2) throw new Error("probe anchor is not unique");
const vitest = join(cloneRoot, "node_modules", "vitest", "vitest.mjs");
const nodeMajor = process.versions.node.split(".")[0];
const label = `${scenario}-node${nodeMajor}`;
const reporterPath = join(evidenceRoot, `${label}-vitest.json`);
const tempRoot = mkdtempSync(join(evidenceRoot, `temp-${label}-`));
const home = join(tempRoot, "home");
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  ComSpec: process.env.ComSpec,
  PATHEXT: process.env.PATHEXT,
  TEMP: tempRoot,
  TMP: tempRoot,
  HOME: home,
  USERPROFILE: home,
  LOHRA_HOME: join(home, "lohra"),
  CODEX_HOME: join(home, "codex"),
  APPDATA: join(tempRoot, "appdata"),
  LOCALAPPDATA: join(tempRoot, "localappdata"),
};
let run;
try {
  writeFileSync(testPath, source.replace(selected.old, selected.replacement));
  run = spawnSync(
    process.execPath,
    [
      vitest,
      "run",
      "tests/gateway/ws-connection.test.ts",
      "-t",
      "valid token: connects, then receives gateway.ready",
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${reporterPath}`,
    ],
    { cwd: cloneRoot, env, encoding: "utf8", timeout: 120_000, maxBuffer: 5 * 1024 * 1024 },
  );
} finally {
  writeFileSync(testPath, source);
}
const report = existsSync(reporterPath) ? JSON.parse(readFileSync(reporterPath, "utf8")) : null;
const failureMessages = (report?.testResults ?? []).flatMap((file) =>
  (file.assertionResults ?? []).flatMap((assertion) => assertion.failureMessages ?? []),
);
const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}\n${failureMessages.join("\n")}`;
const sanitized = combined
  .replaceAll(cloneRoot, "<CLONE>")
  .replaceAll(cloneRoot.replaceAll("\\", "/"), "<CLONE>")
  .replaceAll(tempRoot, "<TEMP>")
  .replaceAll(tempRoot.replaceAll("\\", "/"), "<TEMP>")
  .replaceAll(evidenceRoot, "<EVIDENCE>")
  .replaceAll(evidenceRoot.replaceAll("\\", "/"), "<EVIDENCE>");
writeFileSync(join(evidenceRoot, `${label}.log`), sanitized);
const remaining = readdirSync(tempRoot).filter((name) => name.startsWith("lohra-gateway-ws-"));
const result = {
  scenario,
  node: process.version,
  platform: process.platform,
  childExit: run.status,
  childError: run.error?.code ?? null,
  originalCauseSeen: combined.includes(selected.marker),
  busySeen: /\bEBUSY\b/u.test(combined),
  remainingFixtureRoots: remaining.length,
  remainingStateDb: remaining.filter((name) => existsSync(join(tempRoot, name, "state.db"))).length,
};
writeFileSync(join(evidenceRoot, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
process.exitCode = run.status ?? 1;
