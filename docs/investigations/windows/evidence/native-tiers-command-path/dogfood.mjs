// Execução real: use provider configurado fora do repositório. Este script
// conserva a fixture própria para auditoria; não grava payload nem credenciais.
// LOHRA_842_CHECKOUT=<checkout buildado> LOHRA_842_OUT=<diretório próprio>
// node dogfood.mjs <SHA exato>
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const checkoutEnv = process.env.LOHRA_842_CHECKOUT;
const outEnv = process.env.LOHRA_842_OUT;
const candidate = process.argv[2];
if (!checkoutEnv || !outEnv || !/^[a-f0-9]{40}$/.test(candidate ?? "")) {
  throw new Error("set LOHRA_842_CHECKOUT and LOHRA_842_OUT; pass exact SHA");
}
const checkout = resolve(checkoutEnv);
const out = resolve(outEnv);
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
if (head.status !== 0 || head.stdout.trim() !== candidate) throw new Error("candidate changed");

const fixture = mkdtempSync(join(out, "dogfood-own-"));
const home = join(fixture, "home with spaces");
mkdirSync(home);
writeFileSync(join(home, "workflow_tiers.json"), "[");
const wrapper = join(fixture, "check.mjs");
const marker = "LOHRA842_NATIVE_PATH_OK";
const nestedSource = `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const environment = { ...process.env, LOHRA_HOME: ${JSON.stringify(home + sep)}, CODEX_HOME: ${JSON.stringify(join(fixture, "dummy-codex"))}, NODE_NO_WARNINGS: "1" };
delete environment.LOHRA_PROFILE;
const cli = ${JSON.stringify(join(checkout, "dist/cli.js"))};
const options = { cwd: ${JSON.stringify(fixture)}, env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 1000000 };
const models = spawnSync(process.execPath, [cli, "models", "--json"], options);
const tiers = spawnSync(process.execPath, [cli, "tiers", "list"], options);
const expected = ${JSON.stringify(`workflow_tiers.json at ${join(home, "workflow_tiers.json")} is invalid: is not valid JSON`)};
let payload;
try { payload = JSON.parse(models.stdout); } catch { payload = undefined; }
const report = { modelsExit: models.status, tiersExit: tiers.status, modelsSpawnError: models.error?.code ?? null, tiersSpawnError: tiers.error?.code ?? null, modelsExact: JSON.stringify(payload) === JSON.stringify({ error: expected, providers: [], tiers: {} }), modelsStderrEmpty: models.stderr === "", tiersStdoutEmpty: tiers.stdout === "", tiersStderrExact: tiers.stderr === expected + "\\n" };
writeFileSync(${JSON.stringify(join(out, "dogfood-nested-result.json"))}, JSON.stringify(report, null, 2) + "\\n");
if (report.modelsExit !== 1 || report.tiersExit !== 1 || report.modelsSpawnError || report.tiersSpawnError || !report.modelsExact || !report.modelsStderrEmpty || !report.tiersStdoutEmpty || !report.tiersStderrExact) process.exitCode = 1;
else console.log(${JSON.stringify(marker)});
`;
writeFileSync(wrapper, nestedSource);
const command = `"${process.execPath}" "${wrapper}"`;
const prompt = `Use the terminal tool exactly once with command ${JSON.stringify(command)} and cwd ${JSON.stringify(fixture)}. This runs an isolated check of models and tiers invalid-file diagnostics. If its exit_code is 0 and stdout contains ${marker}, reply only ${marker}. Do not edit files or use other tools.`;
const cli = spawnSync(
  process.execPath,
  [
    join(checkout, "dist/cli.js"),
    "chat",
    "--json",
    "--no-input",
    "--max-iterations",
    "3",
    "--max-parallel",
    "1",
    prompt,
  ],
  { cwd: fixture, encoding: "utf8", timeout: 120_000, maxBuffer: 2_000_000 },
);
let envelope;
try {
  envelope = JSON.parse(cli.stdout);
} catch {
  envelope = undefined;
}
const calls = Array.isArray(envelope?.tool_calls) ? envelope.tool_calls : [];
const call = calls.find((item) => item.name === "terminal");
let result;
try {
  result = typeof call?.result === "string" ? JSON.parse(call.result) : call?.result;
} catch {
  result = undefined;
}
const markerLine = result?.stdout === `${marker}\n` || result?.stdout === `${marker}\r\n`;
const report = {
  candidate,
  node: process.version,
  exit: cli.status,
  signal: cli.signal,
  spawnError: cli.error?.code ?? null,
  parsed: envelope !== undefined,
  errorNull: envelope?.error === null,
  toolCalls: calls.map((item) => item.name),
  toolOk: result?.ok === true,
  toolExit: result?.exit_code ?? null,
  toolStdout: markerLine,
  toolStdoutLineEnding: markerLine ? (result.stdout.endsWith("\r\n") ? "CRLF" : "LF") : null,
  toolStderrEmpty: result?.stderr === "",
  replyMarker: String(envelope?.output ?? "").includes(marker),
  stderrBytes: Buffer.byteLength(cli.stderr ?? ""),
  nestedWarningsSuppressed: true,
  fixtureRetained: "<OWN_FIXTURE>",
};
writeFileSync(
  join(out, "dogfood-orchestrator-result.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
if (
  report.exit !== 0 ||
  !report.errorNull ||
  calls.length !== 1 ||
  !report.toolOk ||
  report.toolExit !== 0 ||
  !report.toolStdout ||
  !report.toolStderrEmpty ||
  !report.replyMarker
) {
  process.exitCode = 1;
}
