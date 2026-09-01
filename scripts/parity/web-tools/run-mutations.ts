#!/usr/bin/env node
/* T20 external mutation proof — baseline → mutant → restore, executed in a
 * temporary COPY of the worktree (the lane workspace is never mutated).
 * Each copy is COMPILED, the mapped T20 proof is EXECUTED (vitest and/or the
 * bilateral harness scenario), and the kill requires: proof red + expected
 * cause visible +, for the five normative mutants (a)–(e), the pinned
 * candidate expectation asserting bodyBytesRead=0. A surviving mutant, a
 * missing scenario, or an invisible cause turns the command red. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { runScenario } from "../harness.js";
import { parseScenarioManifest } from "../manifest.js";
import { resolveOracleWorkspace } from "../resolve.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = resolve(root, ".parity-evidence/t20");

interface Proof {
  readonly kind: "vitest" | "scenario";
  readonly spec: string;
  readonly expectCause?: string;
  readonly expectBodyBytesZero?: boolean;
}

interface Mutant {
  readonly id: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly proofs: readonly Proof[];
}

const VITEST_FILES = [
  "tests/web-safety.test.ts",
  "tests/web-extract.test.ts",
  "tests/web-html-entities.test.ts",
  "tests/web-connector.test.ts",
  "tests/web-connector-node.test.ts",
  "tests/web-fetch.test.ts",
  "tests/web-search.test.ts",
  "tests/web-tool-chat.test.ts",
];

const MUTANTS: readonly Mutant[] = [
  {
    id: "a-peer-membership",
    file: "src/web/connector.ts",
    find: "  if (memberAddressOf(peer, allowed) === null) return \"not-in-validated-set\";\n",
    replace: "  void allowed;\n",
    proofs: [
      { kind: "vitest", spec: "all", expectCause: "peer not in validated set" },
      { kind: "scenario", spec: "t20-peer-matrix", expectBodyBytesZero: true },
    ],
  },
  {
    id: "b-connector-re-resolves",
    file: "src/web/connector.ts",
    find: "        host: (allowed[0] as AddressRecord).address,",
    replace: "        host: request.hostname,",
    proofs: [
      { kind: "vitest", spec: "all", expectCause: "to be '93.184.216.34'" },
      { kind: "scenario", spec: "t20-literal-public", expectBodyBytesZero: false },
    ],
  },
  {
    id: "c-reuse-first-hop-validation",
    file: "src/web/fetch.ts",
    find: "    const validated = await validatePublicUrl(current, { resolver: deps.resolver });",
    replace:
      "    const __t20Cache = globalThis as { __t20Validation?: Awaited<ReturnType<typeof validatePublicUrl>> };\n    const validated = (__t20Cache.__t20Validation ??= await validatePublicUrl(current, { resolver: deps.resolver }));",
    proofs: [
      { kind: "vitest", spec: "all", expectCause: "refusing to fetch a non-public address" },
      { kind: "scenario", spec: "t20-redirect-flow", expectBodyBytesZero: true },
    ],
  },
  {
    id: "d-automatic-redirects",
    file: "src/web/fetch.ts",
    find: `    const response = await deps.connector.request(request);
    lastResponse = response;
    const refusal = peerRefusalCause(response.peer, validated.addresses);
    if (refusal !== null) {
      await response.stream.cancel();
      throw new WebError(refusal);
    }
    if (isRedirectStatus(response.status)) {
      const location = response.headers["location"];
      await response.stream.cancel();
      lastResponse = undefined;
      if (location === undefined || location === "") {
        throw new WebError("redirect response had no Location header");
      }
      current = new URL(location, current).href;
      continue;
    }`,
    replace: `    const response = await deps.connector.request(request);
    if (isRedirectStatus(response.status)) {
      const location = response.headers["location"] ?? "";
      current = new URL(location, current).href;
      continue;
    }`,
    proofs: [
      { kind: "vitest", spec: "all", expectCause: "refusing response from unvalidated peer" },
      { kind: "scenario", spec: "t20-redirect-flow,t20-redirect-limits", expectBodyBytesZero: true },
    ],
  },
  {
    id: "e-tls-verification-off",
    file: "src/web/connector.ts",
    find: "        servername: secure && !isIpLiteral(request.hostname) ? request.hostname : null,\n        rejectUnauthorized: true,",
    replace: "        servername: secure && !isIpLiteral(request.hostname) ? request.hostname : null,\n        rejectUnauthorized: false,",
    proofs: [
      { kind: "vitest", spec: "all", expectCause: "to be true" },
      { kind: "scenario", spec: "t20-transport-failures", expectBodyBytesZero: true },
    ],
  },
  {
    id: "f-userinfo-accepted",
    file: "src/web/safety.ts",
    find: "  if (authority.authority.includes(\"@\")) {\n    throw new WebError(\"refusing URL with embedded credentials\");\n  }",
    replace: "  void authority;",
    proofs: [
      { kind: "vitest", spec: "all", expectCause: "refusing URL with embedded credentials" },
      { kind: "scenario", spec: "t20-userinfo" },
    ],
  },
  {
    id: "g-max-results-11",
    file: "src/web/tool.ts",
    find: "  return Math.max(1, Math.min(parsed, MAX_SEARCH_RESULTS));",
    replace: "  return Math.max(1, Math.min(parsed, MAX_SEARCH_RESULTS + 1));",
    proofs: [
      { kind: "vitest", spec: "all", expectCause: "to be 10" },
      { kind: "scenario", spec: "t20-coercions" },
    ],
  },
  {
    id: "h-ddg-byte-cap-removed",
    file: "src/web/search.ts",
    find: "    if (read.exceeded) {\n      throw new SearchUnavailable(\"search response exceeded 2000000 bytes\");\n    }",
    replace: "    void read;",
    proofs: [
      { kind: "vitest", spec: "all", expectCause: "search response exceeded 2000000 bytes" },
      { kind: "scenario", spec: "t20-ddg-byte-cap" },
    ],
  },
  {
    id: "i-envelope-cause-removed",
    file: "src/web/tool.ts",
    find: "    if (error instanceof WebError) return toolError(error.message, { url });",
    replace: "    if (error instanceof WebError) return toolError(\"fetch failed\", { url });",
    proofs: [
      { kind: "vitest", spec: "all", expectCause: "fetch failed" },
      { kind: "scenario", spec: "t20-scheme-host" },
    ],
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
      !source.includes("/.parity-evidence") &&
      !source.includes("/.probe-evidence"),
  });
  symlinkSync(resolve(root, "node_modules"), resolve(target, "node_modules"), "dir");
  return target;
}

function applyMutant(copy: string, mutant: Mutant): void {
  const path = resolve(copy, mutant.file);
  const source = readFileSync(path, "utf8");
  const occurrences = source.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutant ${mutant.id}: expected exactly one match in ${mutant.file}, found ${String(occurrences)}`,
    );
  }
  writeFileSync(path, source.replace(mutant.find, mutant.replace));
}

function sourceDigest(): string {
  const files = [
    "src/web/connector.ts",
    "src/web/fetch.ts",
    "src/web/safety.ts",
    "src/web/search.ts",
    "src/web/tool.ts",
    "src/tools/builtins.ts",
  ];
  return createHash("sha256")
    .update(files.map((file) => readFileSync(resolve(root, file), "utf8")).join("\0"), "utf8")
    .digest("hex");
}

async function main() {
  const oracleWorkspace = resolveOracleWorkspace({ cwd: root, timeoutMs: 30_000, maxOutputBytes: 1_000_000 }).root;
  const baselineDigest = sourceDigest();
  const results: Record<string, unknown>[] = [];
  let failures = 0;
  for (const mutant of MUTANTS) {
    const copy = makeCopy(mutant.id);
    const proofResults: Record<string, unknown>[] = [];
    let killed = false;
    let causesVisible = true;
    try {
      applyMutant(copy, mutant);
      const build = run("npm", ["run", "build"], copy, 300_000);
      if (build.status !== 0) {
        throw new Error(
          `mutant copy build failed: ${(build.stderr ?? "")}${(build.stdout ?? "")}`.slice(0, 800),
        );
      }
      for (const proof of mutant.proofs) {
        if (proof.kind === "vitest") {
          const unit = run("npx", ["vitest", "run", ...VITEST_FILES], copy, 300_000);
          const stdout = typeof unit.stdout === "string" ? unit.stdout : "";
          const stderr = typeof unit.stderr === "string" ? unit.stderr : "";
          const output = `${stdout}${stderr}`;
          const red = unit.status !== 0;
          const causeVisible = proof.expectCause === undefined || output.includes(proof.expectCause);
          if (red) killed = true;
          if (!causeVisible) causesVisible = false;
          proofResults.push({
            kind: "vitest",
            red,
            exitCode: unit.status,
            causeVisible,
          });
        } else {
          const scenarioIds = proof.spec.split(",");
          for (const scenarioId of scenarioIds) {
            const manifestPath = resolve(
              root,
              `scripts/parity/manifests/t20/${scenarioId}.json`,
            );
            const manifest = parseScenarioManifest(
              JSON.parse(readFileSync(manifestPath, "utf8")),
            );
            let verdict = "";
            let output = "";
            try {
              const record = runScenario(manifest, {
                cwd: copy,
                projectRoot: copy,
                oracleWorkspace,
              });
              verdict = record.verdict;
              output = `${Buffer.from(record.runs.candidate.process.stdout, "base64").toString("utf8")}${Buffer.from(record.runs.oracle.process.stdout, "base64").toString("utf8")}`;
            } catch (error) {
              verdict = "error";
              output = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
              process.stderr.write(`scenario ${scenarioId} error: ${output.slice(0, 600)}\n`);
            }
            const nominal = await nominalVerdict(scenarioId);
            const flipped = verdict !== nominal;
            if (flipped) killed = true;
            if (proof.expectCause !== undefined && !output.includes(proof.expectCause)) {
              causesVisible = false;
            }
            const candidateExpectation = manifest.expectations
              .filter((expectation) => expectation.side !== "oracle")
              .map((expectation) => (typeof expectation.value === "string" ? expectation.value : JSON.stringify(expectation.value)))
              .join("\n");
            const bodyZeroPinned =
              proof.expectBodyBytesZero !== true ||
              candidateExpectation.includes('"bodyBytesRead": 0');
            if (!bodyZeroPinned) causesVisible = false;
            proofResults.push({
              kind: "scenario",
              scenario: scenarioId,
              nominal,
              mutantVerdict: verdict,
              flipped,
              causeVisible:
                proof.expectCause === undefined || output.includes(proof.expectCause),
              bodyZeroPinned,
            });
          }
        }
      }
    } catch (error) {
      causesVisible = false;
      proofResults.push({
        kind: "setup",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
    const record = {
      mutant: mutant.id,
      killed,
      causesVisible,
      proofs: proofResults,
    };
    if (!killed || !causesVisible) failures += 1;
    results.push(record);
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
  if (sourceDigest() !== baselineDigest) {
    process.stderr.write("t20 mutation proof: the lane worktree changed during the run\n");
    failures += 1;
  }
  const summary = { suite: "t20-mutations", mutants: MUTANTS.length, failures, results };
  writeFileSync(
    resolve(evidenceDirectory, "mutations.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ suite: "t20-mutations", failures, mutants: MUTANTS.length })}\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

function nominalVerdictSync(scenarioId: string): string {
  const expectedDivergent = new Set([
    "t20-port-invalid",
    "t20-userinfo",
    "t20-non-public-literals",
    "t20-literal-public",
    "t20-redirect-flow",
    "t20-fetch-bounds",
    "t20-peer-matrix",
    "t20-ddg-byte-cap",
  ]);
  return expectedDivergent.has(scenarioId) ? "divergent" : "match";
}

async function nominalVerdict(scenarioId: string): Promise<string> {
  return nominalVerdictSync(scenarioId);
}

await main();
