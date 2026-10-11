// Reproduza em Windows com o provider configurado fora do repositório.
// LOHRA_859_CHECKOUT: checkout buildado no SHA passado em argv[2].
// LOHRA_859_OUT: diretório temporário próprio para o cwd e resultado.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const checkoutEnv = process.env.LOHRA_859_CHECKOUT;
const outEnv = process.env.LOHRA_859_OUT;
const candidate = process.argv[2];
if (!checkoutEnv || !outEnv || !/^[a-f0-9]{40}$/.test(candidate ?? "")) {
  throw new Error("set LOHRA_859_CHECKOUT and LOHRA_859_OUT; pass exact candidate SHA");
}
const checkout = resolve(checkoutEnv);
const out = resolve(outEnv);
const actual = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
if (actual.status !== 0 || actual.stdout.trim() !== candidate) {
  throw new Error("candidate changed");
}

const workspace = mkdtempSync(join(out, "dogfood-own-"));
const marker = "LOHRA859_TOOL_OK";
const prompt = `Use the terminal tool exactly once with command "echo ${marker}" and cwd ${JSON.stringify(workspace)}. If its exit_code is 0 and stdout contains ${marker}, reply only ${marker}. Do not edit files or use other tools.`;
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
  { cwd: workspace, encoding: "utf8", timeout: 120_000, maxBuffer: 2_000_000 },
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
let removed = false;
let cleanupError = null;
if (workspace.startsWith(out + sep) && !lstatSync(workspace).isSymbolicLink()) {
  try {
    rmSync(workspace, { recursive: true });
    removed = !existsSync(workspace);
  } catch (error) {
    cleanupError = error.code ?? error.name;
  }
} else {
  cleanupError = "unsafe-owned-path";
}
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
  toolStdout: result?.stdout === `${marker}\r\n`,
  toolStderrEmpty: result?.stderr === "",
  replyMarker: String(envelope?.output ?? "").includes(marker),
  stderrBytes: Buffer.byteLength(cli.stderr ?? ""),
  removed,
  cleanupError,
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
  !report.replyMarker ||
  !report.removed
) {
  process.exitCode = 1;
}
