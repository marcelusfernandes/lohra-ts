import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveOracleWorkspace } from "../resolve.js";

interface Mutation {
  readonly id: string;
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly extra?: Readonly<{ path: string; content: string }>;
  readonly command:
    | "t22-test"
    | "docs-test"
    | "mcp-test"
    | "security"
    | "composition"
    | "no-python"
    | "pty"
    | "inventory"
    | "concurrency";
  readonly expected: string;
}

const project = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = join(project, ".parity-evidence", "t22");
const nodeModules = join(project, "node_modules");
const dist = join(project, "dist");
const tsc = join(nodeModules, "typescript", "bin", "tsc");
const vitest = join(nodeModules, "vitest", "vitest.mjs");
const tsx = join(nodeModules, "tsx", "dist", "cli.mjs");
const oracleWorkspace = resolveOracleWorkspace({
  cwd: project,
  environment: process.env,
  timeoutMs: 5_000,
  maxOutputBytes: 256 * 1024,
});

const mutations: readonly Mutation[] = [
  {
    id: "T22-ancestor-inventory",
    file: "scripts/parity/closeout/verify-evidence.ts",
    before: "5b2d62c65f282683609d5d3801b3bfaf4448aff4",
    after: "ffffffffffffffffffffffffffffffffffffffff",
    command: "t22-test",
    expected: "MUTATION_CAUSE:T22-ancestor-inventory",
  },
  {
    id: "T22-hotspot-workflow-handler",
    file: "src/commands/session-tools.ts",
    before: "    ...workflowToolHandlers(options.workflowService, options.base.auditRepository),",
    after: "    ...{},",
    command: "composition",
    expected: "COMPOSITION_PLACEHOLDER:chat:run_workflow",
  },
  {
    id: "T22-l22-promotion-reopened",
    file: "src/gateway/session-service.ts",
    before: '      return "subsession";',
    after: "      return null;",
    command: "security",
    expected: "SUBSESSION_PRIVILEGE_PROMOTION_DENIED",
  },
  {
    id: "T22-mcp-last-wins",
    file: "src/mcp/manager.ts",
    before:
      "        if (seen.has(registration.name)) throw new MCPToolNameCollisionError(registration.name);",
    after: "        if (seen.has(registration.name)) continue;",
    command: "mcp-test",
    expected: "MCP_TOOL_NAME_COLLISION",
  },
  {
    id: "T22-updater-shell",
    file: "src/self-update/repo.ts",
    before: "    shell: false,",
    after: "    shell: true,",
    command: "t22-test",
    expected: "MUTATION_CAUSE:T22-updater-shell",
  },
  {
    id: "T22-updater-non-ff",
    file: "src/self-update/service.ts",
    before: '["pull", "--ff-only"]',
    after: '["pull"]',
    command: "t22-test",
    expected: "MUTATION_CAUSE:T22-updater-ff-only",
  },
  {
    id: "T22-updater-host-cwd",
    file: "src/self-update/service.ts",
    before: "locateRepo(dirname(fileURLToPath(moduleUrl)))",
    after: "locateRepo(process.cwd())",
    command: "t22-test",
    expected: "MUTATION_CAUSE:T22-updater-cwd",
  },
  {
    id: "T22-tarball-python",
    file: "package.json",
    before: '    "scripts/postinstall.mjs"',
    after: '    "scripts/postinstall.mjs",\n    "t22-mutant.py"',
    extra: { path: "t22-mutant.py", content: "raise SystemExit('must never ship')\n" },
    command: "no-python",
    expected: "TARBALL_FORBIDDEN:t22-mutant.py",
  },
  {
    id: "T22-node-pty-bypass",
    file: "src/tools/terminal.ts",
    before: "child = spawnPty(invocation.executable, [...invocation.args], {",
    after: "child = spawnPty(process.execPath, [...invocation.args], {",
    command: "pty",
    expected: "PTY_STDOUT",
  },
  {
    id: "T22-script-omitted",
    file: "package.json",
    before: '    "probe:t22:security": "tsx scripts/parity/closeout/security.ts",\n',
    after: "",
    command: "inventory",
    expected: "INVENTORY_TARGET:probe:t22:security:missing",
  },
  {
    id: "T22-normalization-broad",
    file: "scripts/parity/closeout/normalization.ts",
    before:
      'export function normalizeCloseoutOutput(value: string): string {\n  return collapseSuccessfulVitestTelemetry(stripAnsi(value).split("\\n"))',
    after:
      'export function normalizeCloseoutOutput(value: string): string {\n  return collapseSuccessfulVitestTelemetry(\n    stripAnsi(value)\n      .replaceAll(/Today\'s date is \\d{4}-\\d{2}-\\d{2}/gu, "Today\'s date is <date>")\n      .split("\\n"),\n  )',
    command: "t22-test",
    expected: "MUTATION_CAUSE:T22-normalization-scope",
  },
  {
    id: "T22-vitest-parallel-telemetry",
    file: "scripts/parity/closeout/normalization.ts",
    before: 'return collapseSuccessfulVitestTelemetry(stripAnsi(value).split("\\n"))',
    after: 'return stripAnsi(value).split("\\n")',
    command: "t22-test",
    expected: "MUTATION_CAUSE:T22-vitest-parallel-telemetry",
  },
  {
    id: "T22-t19-test-stream-order",
    file: "scripts/parity/mcp/run-regression-gates-locked.sh",
    before: "npm test 2>&1",
    after: "npm test",
    command: "t22-test",
    expected: "MUTATION_CAUSE:T22-t19-test-stream-order",
  },
  {
    id: "T22-fixed-port",
    file: "scripts/parity/closeout/composition.ts",
    before: 'upstream.listen(0, "127.0.0.1"',
    after: 'upstream.listen(11434, "127.0.0.1"',
    command: "concurrency",
    expected: "CONCURRENT_GATE_",
  },
  {
    id: "T22-platform-spoof",
    file: "scripts/parity/closeout/verify-evidence.ts",
    before: 'D16: { status: "NOT_MEASURED"',
    after: 'D16: { status: "PASS"',
    command: "t22-test",
    expected: "MUTATION_CAUSE:T22-platform-spoof",
  },
  {
    id: "T22-docs-obsolete",
    file: "README.md",
    before: "A versão atual é `0.0.11`.",
    after: "A versão atual é `0.0.10`.",
    command: "docs-test",
    expected: "MUTATION_CAUSE:T22-docs-current-version",
  },
  {
    id: "T22-node20-sqlite-dependency",
    file: "package.json",
    before: '    "better-sqlite3": "11.10.0",',
    after: '    "better-sqlite3": "^13.0.3",',
    command: "t22-test",
    expected: "MUTATION_CAUSE:T22-node20-sqlite-dependency",
  },
];

function run(
  cwd: string,
  executable: string,
  args: readonly string[],
  timeout = 120_000,
): { readonly status: number; readonly output: string } {
  const result = spawnSync(executable, [...args], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TZ: "UTC",
      LOHRA_ORACLE_WORKSPACE: oracleWorkspace.root,
    },
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, output: `${result.stdout}\n${result.stderr}` };
}

function replaceOnce(root: string, mutation: Mutation): void {
  const path = join(root, mutation.file);
  const value = readFileSync(path, "utf8");
  if (value.split(mutation.before).length !== 2) throw new Error(`MUTATION_ANCHOR:${mutation.id}`);
  writeFileSync(path, value.replace(mutation.before, mutation.after));
  if (mutation.extra !== undefined) {
    const extra = join(root, mutation.extra.path);
    mkdirSync(resolve(extra, ".."), { recursive: true });
    writeFileSync(extra, mutation.extra.content);
  }
}

function command(
  root: string,
  name: Mutation["command"],
): { readonly status: number; readonly output: string } {
  if (name === "t22-test")
    return run(root, process.execPath, [
      vitest,
      "run",
      "tests/t22-closeout.test.ts",
      "--reporter=dot",
    ]);
  if (name === "docs-test")
    return run(root, process.execPath, [vitest, "run", "tests/t22-docs.test.ts", "--reporter=dot"]);
  if (name === "mcp-test")
    return run(root, process.execPath, [
      vitest,
      "run",
      "tests/mcp-manager.test.ts",
      "--reporter=dot",
    ]);
  if (name === "security")
    return run(root, process.execPath, [tsx, "scripts/parity/closeout/security.ts"]);
  if (name === "pty") return run(root, process.execPath, [tsx, "scripts/parity/closeout/pty.ts"]);
  if (name === "inventory")
    return run(root, process.execPath, [
      tsx,
      "scripts/parity/closeout/run-closeout.ts",
      "--check-only",
    ]);
  if (name === "no-python")
    return run(root, process.execPath, [tsx, "scripts/parity/closeout/no-python.ts"]);
  if (name === "concurrency")
    return run(root, process.execPath, [tsx, "scripts/parity/closeout/concurrency.ts"]);
  return run(root, process.execPath, [tsx, "scripts/parity/closeout/composition.ts"]);
}

const baseline = run(project, process.execPath, [
  vitest,
  "run",
  "tests/t22-closeout.test.ts",
  "tests/t22-docs.test.ts",
  "tests/mcp-manager.test.ts",
  "--reporter=dot",
]);
if (baseline.status !== 0) throw new Error(`MUTATION_BASELINE:${baseline.output}`);
const root = mkdtempSync(join(tmpdir(), "lohra-t22-mutations-"));
const results: Array<Readonly<Record<string, unknown>>> = [];
try {
  const archive = join(root, "source.tar");
  const archived = run(project, "git", ["archive", "--format=tar", "HEAD", "-o", archive]);
  if (archived.status !== 0) throw new Error(`MUTATION_ARCHIVE:${archived.output}`);
  for (const mutation of mutations) {
    const copy = join(root, mutation.id);
    mkdirSync(copy, { recursive: true });
    const extracted = run(copy, "/usr/bin/tar", ["-xf", archive]);
    if (extracted.status !== 0) throw new Error(`MUTATION_EXTRACT:${mutation.id}`);
    symlinkSync(nodeModules, join(copy, "node_modules"), "dir");
    if (mutation.command !== "composition") {
      symlinkSync(dist, join(copy, "dist"), "dir");
    }
    replaceOnce(copy, mutation);
    const compile = run(
      copy,
      process.execPath,
      mutation.command === "composition" ? [tsc, "-p", "tsconfig.build.json"] : [tsc, "--noEmit"],
    );
    const observed = compile.status === 0 ? command(copy, mutation.command) : compile;
    const killed =
      compile.status === 0 && observed.status !== 0 && observed.output.includes(mutation.expected);
    results.push({
      id: mutation.id,
      compile: compile.status,
      exit: observed.status,
      causeVisible: observed.output.includes(mutation.expected),
      killed,
    });
    if (!killed) throw new Error(`MUTATION_SURVIVED:${mutation.id}:${observed.output}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const legacyIds = [
  "mutations:t15",
  "mutations:t16",
  "mutations:t17",
  "parity:t20:mutations",
  "mutations:t21",
] as const;
const legacy: Array<Readonly<Record<string, unknown>>> = [];
for (const id of process.argv.includes("--t22-only") ? [] : legacyIds) {
  const digests: string[] = [];
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const result = run(project, "npm", ["run", id], 20 * 60_000);
    if (result.status !== 0) throw new Error(`LEGACY_MUTATION_EXIT:${id}:${result.output}`);
    const line = result.output
      .split("\n")
      .map((value) => value.trim())
      .filter((value) => value.startsWith("{") && value.endsWith("}"))
      .at(-1);
    if (line === undefined) throw new Error(`LEGACY_MUTATION_OUTPUT:${id}`);
    const parsed = JSON.parse(line) as {
      readonly survivors?: readonly unknown[];
      readonly digest?: unknown;
    };
    if (!Array.isArray(parsed.survivors) || parsed.survivors.length !== 0) {
      throw new Error(`LEGACY_MUTATION_SURVIVOR:${id}`);
    }
    digests.push(
      typeof parsed.digest === "string"
        ? parsed.digest
        : createHash("sha256").update(line).digest("hex"),
    );
  }
  if (digests[0] !== digests[1]) throw new Error(`LEGACY_MUTATION_NONDETERMINISTIC:${id}`);
  legacy.push({ id, runs: 2, digest: digests[0], survivors: 0 });
}

const observation = {
  targetSha: run(project, "git", ["rev-parse", "HEAD"]).output.trim(),
  t22: { baseline: true, killed: results.length, survivors: [], results },
  legacy,
  restoreClean: run(project, "git", ["status", "--porcelain"]).output.trim() === "",
  networkUsed: false,
  credentialsUsed: false,
};
if (!observation.restoreClean) throw new Error("MUTATION_RESTORE_DIRTY");
const canonical = `${JSON.stringify(observation)}\n`;
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(join(evidenceDirectory, "mutations-closeout.json"), canonical);
process.stdout.write(
  `${JSON.stringify({ ...observation, digest: createHash("sha256").update(canonical).digest("hex") })}\n`,
);
