#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { runCli } from "../cli.js";

const scenarios = resolve("scripts/parity/scenarios");
const names = readdirSync(scenarios)
  .filter((name) => name.startsWith("t05-") && name.endsWith(".json"))
  .sort();
let failures = 0;
for (const name of names) {
  const id = name.slice(0, -5);
  const code = runCli([
    "--manifest",
    resolve(scenarios, name),
    "--evidence",
    resolve(".parity-evidence", `${id}.json`),
  ]);
  const expected = id === "t05-expiry-boundary-mutant" ? 1 : 0;
  if (code !== expected) failures += 1;
}
process.stdout.write(
  `${JSON.stringify({ suite: "t05-auth", scenarios: names.length, failures })}\n`,
);
process.exitCode = failures === 0 && names.length === 26 ? 0 : 1;
