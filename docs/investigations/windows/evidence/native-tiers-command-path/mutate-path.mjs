// Sonda externa: troca uma composição de path por vez, roda a asserção de
// contrato correspondente e restaura os bytes originais no finally.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const checkout = resolve(process.argv[2] ?? "");
const output = resolve(process.argv[3] ?? "");
if (!checkout || !output) throw new Error("usage: node mutate-path.mjs <checkout> <output-dir>");
const cases = [
  {
    name: "models",
    source: "src/commands/models.ts",
    before: 'readTiers(join(options.home, "workflow_tiers.json"))',
    after: "readTiers(`${options.home}/workflow_tiers.json`)",
    test: "tests/models.test.ts",
  },
  {
    name: "tiers",
    source: "src/commands/tiers.ts",
    before: 'join(options.home, "workflow_tiers.json")',
    after: "`${options.home}/workflow_tiers.json`",
    test: "tests/workflow-tiers.test.ts",
  },
];
const report = [];
for (const entry of cases) {
  const source = join(checkout, entry.source);
  const original = readFileSync(source, "utf8");
  if (!original.includes(entry.before)) throw new Error(`anchor absent: ${entry.name}`);
  if (original.split(entry.before).length !== 2) throw new Error(`anchor ambiguous: ${entry.name}`);
  let result;
  try {
    writeFileSync(source, original.replace(entry.before, entry.after));
    result = spawnSync(
      process.execPath,
      [
        join(checkout, "node_modules/vitest/vitest.mjs"),
        "run",
        entry.test,
        "-t",
        "reports the native tier path when home ends with a separator",
        "--maxWorkers=1",
      ],
      {
        cwd: checkout,
        env: process.env,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } finally {
    writeFileSync(source, original);
    if (readFileSync(source, "utf8") !== original) throw new Error(`restore failed: ${entry.name}`);
  }
  writeFileSync(join(output, `mutant-${entry.name}.log`), `${result.stdout}${result.stderr}`);
  report.push({
    mutant: entry.name,
    status: result.status,
    signal: result.signal,
    error: result.error?.code ?? null,
    assertionRed: `${result.stdout}${result.stderr}`.includes("AssertionError"),
    restored: true,
  });
}
writeFileSync(join(output, "mutations.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (report.some((entry) => entry.status !== 1 || !entry.assertionRed)) process.exitCode = 1;
