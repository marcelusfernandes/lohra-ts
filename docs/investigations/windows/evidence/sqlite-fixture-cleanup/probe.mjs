// Run only in a disposable clone marked with .lohra-disposable-probe.
// Intentionally breaks one existing assertion, then records whether Vitest
// reports that primary failure and whether the fixture removed state.db.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [cloneArgument, scenario, evidenceArgument] = process.argv.slice(2);
if (!cloneArgument || !scenario || !evidenceArgument) {
  throw new Error(
    "usage: node probe.mjs <marked-disposable-clone> <policy|acquisition> <evidence-dir>",
  );
}
const cloneRoot = resolve(cloneArgument);
const evidenceRoot = resolve(evidenceArgument);
if (!existsSync(join(cloneRoot, ".lohra-disposable-probe"))) {
  throw new Error("refusing to modify an unmarked checkout");
}
const cases = {
  policy: {
    title: "the leaf dispatch of a launched run carries the OPERATOR policy",
    old: 'out: "allowed:write_file"',
    replacement: 'out: "PROBE_WRONG_ALLOWED_VALUE"',
    marker: "PROBE_WRONG_ALLOWED_VALUE",
  },
  acquisition: {
    title: "installs one sandbox per ACQUISITION and disposes only its own",
    old: '.toBe("ERROR: workflow stretch is no longer current (sandbox denied)")',
    replacement: '.toBe("PROBE_WRONG_DENIAL_VALUE")',
    marker: "PROBE_WRONG_DENIAL_VALUE",
  },
};
const selected = cases[scenario];
if (!selected) throw new Error(`unknown scenario: ${scenario}`);
const testPath = join(cloneRoot, "tests", "workflow-service-durability.test.ts");
const source = readFileSync(testPath, "utf8");
const start = source.indexOf(`it("${selected.title}`);
if (start < 0) throw new Error("target test not found");
const next = source.indexOf("\n  it(", start + 4);
const end = next < 0 ? source.length : next;
const target = source.slice(start, end);
if (!target.includes(selected.old)) throw new Error("assertion anchor not found in target test");
writeFileSync(
  testPath,
  source.slice(0, start) + target.replace(selected.old, selected.replacement) + source.slice(end),
);

mkdirSync(evidenceRoot, { recursive: true });
const tempRoot = join(evidenceRoot, `temp-${scenario}`);
mkdirSync(tempRoot, { recursive: true });
const vitest = join(cloneRoot, "node_modules", "vitest", "vitest.mjs");
const run = spawnSync(
  process.execPath,
  [
    vitest,
    "run",
    "tests/workflow-service-durability.test.ts",
    "-t",
    selected.title,
    "--maxWorkers=1",
  ],
  {
    cwd: cloneRoot,
    env: {
      ...process.env,
      TEMP: tempRoot,
      TMP: tempRoot,
      LOHRA_HOME: join(tempRoot, "home"),
      CODEX_HOME: join(tempRoot, "codex"),
    },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 5 * 1024 * 1024,
  },
);
const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const sanitized = combined
  .replaceAll(cloneRoot, "<CLONE>")
  .replaceAll(cloneRoot.replaceAll("\\", "/"), "<CLONE>")
  .replaceAll(tempRoot, "<TEMP>")
  .replaceAll(tempRoot.replaceAll("\\", "/"), "<TEMP>");
writeFileSync(join(evidenceRoot, `${scenario}.log`), sanitized);
const remaining = readdirSync(tempRoot).filter((name) => name.startsWith("lohra-service-sandbox-"));
const result = {
  scenario,
  node: process.version,
  platform: process.platform,
  childExit: run.status,
  childError: run.error?.code ?? null,
  assertionSeen: combined.includes("AssertionError") && combined.includes(selected.marker),
  busySeen: /\bEBUSY\b/u.test(combined),
  remainingFixtureRoots: remaining.length,
  remainingStateDb: remaining.filter((name) => existsSync(join(tempRoot, name, "state.db"))).length,
};
writeFileSync(join(evidenceRoot, `${scenario}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
process.exitCode = run.status ?? 1;
