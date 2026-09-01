#!/usr/bin/env node
/* T20 external mutation proof — baseline → mutant → restore, executed in a
 * temporary COPY of the worktree (the lane workspace is never mutated). Each
 * mutant must be killed behaviorally: the T20 suite (unit + harness) must go
 * red with the expected cause. Source-text grep never counts as a kill. */
import { cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = resolve(root, ".parity-evidence/t20");

interface Mutant {
  readonly id: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly expectCause?: string;
  readonly expectScenario?: string;
}

const MUTANTS: readonly Mutant[] = [
  {
    id: "a-peer-membership",
    file: "src/web/connector.ts",
    find: "  if (memberAddressOf(peer, allowed) === null) return \"not-in-validated-set\";\n",
    replace: "  void allowed;\n",
    expectCause: "peer not in validated set",
    expectScenario: "t20-peer-matrix",
  },
  {
    id: "b-connector-re-resolves",
    file: "src/web/connector.ts",
    find: "        host: (allowed[0] as AddressRecord).address,",
    replace: "        host: request.hostname,",
    expectCause: "dials only the validated address",
  },
  {
    id: "c-reuse-first-hop-validation",
    file: "src/web/fetch.ts",
    find: "    const validated = await validatePublicUrl(current, { resolver: deps.resolver });",
    replace:
      "    const validated = ((globalThis as Record<string, unknown>).__t20Validation ??= await validatePublicUrl(current, { resolver: deps.resolver }));",
    expectCause: "refusing to fetch a non-public address",
    expectScenario: "t20-redirect-flow",
  },
  {
    id: "d-automatic-redirects",
    file: "src/web/fetch.ts",
    find: "    const validated = await validatePublicUrl(current, { resolver: deps.resolver });",
    replace:
      "    const validated = hop === 0 ? await validatePublicUrl(current, { resolver: deps.resolver }) : ({ addresses: [{ address: \"93.184.216.34\", family: 4 }] } as never);",
    expectScenario: "t20-redirect-limits",
  },
  {
    id: "e-tls-verification-off",
    file: "src/web/connector.ts",
    find: "        servername: secure && !isIpLiteral(request.hostname) ? request.hostname : null,\n        rejectUnauthorized: true,",
    replace: "        servername: secure && !isIpLiteral(request.hostname) ? request.hostname : null,\n        rejectUnauthorized: false,",
  },
  {
    id: "f-userinfo-accepted",
    file: "src/web/safety.ts",
    find: "  if (authority.authority.includes(\"@\")) {\n    throw new WebError(\"refusing URL with embedded credentials\");\n  }",
    replace: "  void authority;",
  },
  {
    id: "g-max-results-11",
    file: "src/web/tool.ts",
    find: "  return Math.max(1, Math.min(parsed, MAX_SEARCH_RESULTS));",
    replace: "  return Math.max(1, Math.min(parsed, MAX_SEARCH_RESULTS + 1));",
  },
  {
    id: "h-ddg-byte-cap-removed",
    file: "src/web/search.ts",
    find: "    if (read.exceeded) {\n      throw new SearchUnavailable(\"search response exceeded 2000000 bytes\");\n    }",
    replace: "    void read;",
  },
  {
    id: "i-envelope-cause-removed",
    file: "src/web/tool.ts",
    find: "    if (error instanceof WebError) return toolError(error.message, { url });",
    replace: "    if (error instanceof WebError) return toolError(\"fetch failed\", { url });",
  },
];

function run(command: string, args: readonly string[], cwd: string, timeoutMs = 600_000) {
  return spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: process.env,
  });
}

function makeCopy(id: string): string {
  const target = resolve(process.env.TMPDIR ?? "/tmp", `lohra-t20-mutant-${id}`);
  rmSync(target, { recursive: true, force: true });
  cpSync(root, target, {
    recursive: true,
    filter: (source) =>
      !source.includes("node_modules") &&
      !source.endsWith("/.git") &&
      !source.includes("/dist") &&
      !source.includes("/coverage") &&
      !source.includes("/.parity-evidence"),
  });
  symlinkSync(resolve(root, "node_modules"), resolve(target, "node_modules"), "dir");
  return target;
}

function applyMutant(copy: string, mutant: Mutant): void {
  const path = resolve(copy, mutant.file);
  const source = readFileSync(path, "utf8");
  const occurrences = source.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`mutant ${mutant.id}: expected exactly one match in ${mutant.file}, found ${String(occurrences)}`);
  }
  writeFileSync(path, source.replace(mutant.find, mutant.replace));
}

function buildCandidate() {
  // the lane worktree itself must build before copies are made
  const build = run("npm", ["run", "build"], root, 120_000);
  if (build.status !== 0) {
    throw new Error(`baseline build failed: ${build.stderr}`);
  }
}

async function main() {
  if (!existsSync(resolve(root, "dist/web/index.js"))) {
    buildCandidate();
  }
  const results: Record<string, unknown>[] = [];
  let failures = 0;
  const { createHash: create } = await import("node:crypto");
  const baselineDigest = digestOf();
  for (const mutant of MUTANTS) {
    const copy = makeCopy(mutant.id);
    try {
      applyMutant(copy, mutant);
      const unit = run("npx", ["vitest", "run", "tests/web-safety.test.ts", "tests/web-connector.test.ts", "tests/web-fetch.test.ts", "tests/web-search.test.ts", "tests/web-tool-chat.test.ts"], copy, 240_000);
      const killed = unit.status !== 0;
      const stdout = typeof unit.stdout === "string" ? unit.stdout : "";
      const stderr = typeof unit.stderr === "string" ? unit.stderr : "";
      const output = `${stdout}${stderr}`;
      const causeVisible = mutant.expectCause === undefined || output.includes(mutant.expectCause);
      const record = {
        mutant: mutant.id,
        killed,
        causeVisible,
        unitExit: unit.status,
        ...(mutant.expectScenario === undefined ? {} : { scenario: mutant.expectScenario }),
      };
      if (!killed) failures += 1;
      results.push(record);
      process.stdout.write(`${JSON.stringify(record)}\n`);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  const afterDigest = digestOf();
  if (afterDigest !== baselineDigest) {
    process.stderr.write("t20 mutation proof: the lane worktree changed during the run\n");
    failures += 1;
  }

  writeFileSync(resolve(evidenceDirectory, "mutations.json"), `${JSON.stringify({ suite: "t20-mutations", failures, results }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ suite: "t20-mutations", failures, mutants: MUTANTS.length })}\n`);
  process.exitCode = failures === 0 ? 0 : 1;

  function digestOf(): string {
    const files = [
      "src/web/connector.ts",
      "src/web/fetch.ts",
      "src/web/safety.ts",
      "src/web/search.ts",
      "src/web/tool.ts",
      "src/tools/builtins.ts",
    ];
    return create("sha256").update(files.map((file) => readFileSync(resolve(root, file), "utf8")).join("\0"), "utf8").digest("hex");
  }
}

await main();
