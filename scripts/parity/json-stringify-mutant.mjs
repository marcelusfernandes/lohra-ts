#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const [candidate, ...argv] = process.argv.slice(2);
if (candidate === undefined) throw new Error("candidate entrypoint is required");
const result = spawnSync(process.execPath, [candidate, ...argv], {
  cwd: process.cwd(),
  env: { ...process.env },
  encoding: "utf8",
  shell: false,
  timeout: 5_000,
  maxBuffer: 1_048_576,
  killSignal: "SIGKILL",
});
if (result.error !== undefined) throw result.error;
process.stderr.write(result.stderr);
process.stdout.write(`${JSON.stringify(JSON.parse(result.stdout))}\n`);
process.exitCode = result.status ?? 2;
