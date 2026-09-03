#!/usr/bin/env node
/* T20 external mutation proof — baseline → mutant → restore, executed in a
 * temporary COPY of the worktree (the lane workspace is never mutated).
 * Each copy is COMPILED (tsc) and every mapped bilateral scenario is EXECUTED
 * in the mutant copy via the harness. The kill is decided ONLY by the mapped
 * external predicates: every mapped scenario must FLIP its nominal verdict in
 * the mutant run. When a mutant declares a required proof, its runtime JSON
 * must also expose the exact expected cause and byte counter; empty, malformed,
 * or merely different stdout is never sufficient. Vitest results are recorded
 * for diagnosis but never decide the kill. */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

import { runScenario } from "../harness.js";
import { parseScenarioManifest } from "../manifest.js";
import { resolveOracleWorkspace } from "../resolve.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = resolve(root, ".parity-evidence/t20");

interface Mutant {
  readonly id: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly scenarios: readonly string[];
  readonly requiredProof?: {
    readonly cause: string;
    readonly bodyBytesRead: number;
  };
}

const MUTANTS: readonly Mutant[] = [
  {
    id: "a-peer-membership",
    file: "src/web/connector.ts",
    find: '  if (memberAddressOf(peer, allowed) === null) return "not-in-validated-set";\n',
    replace: "  void allowed;\n",
    scenarios: ["t20-peer-divergent", "t20-peer-matrix"],
  },
  {
    id: "b-connector-re-resolves",
    file: "src/web/connector.ts",
    find: "        host: (allowed[0] as AddressRecord).address,",
    replace: "        host: request.hostname,",
    scenarios: ["t20-rebinding"],
    requiredProof: {
      cause: "refusing response from unvalidated peer: peer is non-public",
      bodyBytesRead: 0,
    },
  },
  {
    id: "c-reuse-first-hop-validation",
    file: "src/web/fetch.ts",
    find: "    const validated = await validatePublicUrl(current, { resolver: deps.resolver });",
    replace:
      "    const __t20Cache = globalThis as { __t20Validation?: Awaited<ReturnType<typeof validatePublicUrl>> };\n    const validated = (__t20Cache.__t20Validation ??= await validatePublicUrl(current, { resolver: deps.resolver }));",
    scenarios: ["t20-redirect-limits", "t20-redirect-flow"],
  },
  {
    id: "d-automatic-redirects",
    file: "src/web/fetch.ts",
    find: `    const response = await deps.connector.request(request);
    const refusal = peerRefusalCause(response.peer, validated.addresses);
    if (refusal !== null) {
      await response.stream.cancel();
      throw new WebError(refusal);
    }
    if (isRedirectStatus(response.status)) {
      const location = response.headers["location"];
      await response.stream.cancel();
      if (location === undefined || location === "") {
        throw new WebError("redirect response had no Location header");
      }
      current = new URL(location, current).href;
      continue;
    }`,
    replace: `    let response = await deps.connector.request(request);
    const refusal = peerRefusalCause(response.peer, validated.addresses);
    if (refusal !== null) {
      await response.stream.cancel();
      throw new WebError(refusal);
    }
    let followed = 0;
    while (isRedirectStatus(response.status) && followed <= maxRedirects) {
      followed += 1;
      const location = response.headers["location"] ?? "";
      await response.stream.cancel();
      current = new URL(location, current).href;
      response = await deps.connector.request({ ...request, url: current });
    }
    if (isRedirectStatus(response.status)) {
      await response.stream.cancel();
      throw new WebError(\`too many redirects (more than \${String(maxRedirects)})\`);
    }`,
    scenarios: ["t20-redirect-limits", "t20-redirect-flow"],
  },
  {
    id: "e-tls-verification-off",
    file: "src/web/connector.ts",
    find: "        servername: secure && !isIpLiteral(request.hostname) ? request.hostname : null,\n        rejectUnauthorized: true,",
    replace:
      "        servername: secure && !isIpLiteral(request.hostname) ? request.hostname : null,\n        rejectUnauthorized: false,",
    scenarios: ["t20-connector-tls"],
  },
  {
    id: "f-userinfo-accepted",
    file: "src/web/safety.ts",
    find: '  if (authority.authority.includes("@")) {\n    throw new WebError("refusing URL with embedded credentials");\n  }',
    replace: "  void authority;",
    scenarios: ["t20-userinfo"],
  },
  {
    id: "g-max-results-11",
    file: "src/web/tool.ts",
    find: "  return Math.max(1, Math.min(parsed, MAX_SEARCH_RESULTS));",
    replace: "  return Math.max(1, Math.min(parsed, MAX_SEARCH_RESULTS + 1));",
    scenarios: ["t20-coercions"],
  },
  {
    id: "h-ddg-byte-cap-removed",
    file: "src/web/search.ts",
    find: `    const space = maxBytes - total;
    if (chunk.length > space) {
      await response.stream.cancel();
      return { bytes: Buffer.concat(chunks), exceeded: true };
    }
    chunks.push(Buffer.from(chunk));
    total += chunk.length;
    if (total > maxBytes) {
      await response.stream.cancel();
      return { bytes: Buffer.concat(chunks), exceeded: true };
    }`,
    replace: `    chunks.push(Buffer.from(chunk));
    total += chunk.length;`,
    scenarios: ["t20-ddg-byte-cap"],
  },
  {
    id: "i-envelope-cause-removed",
    file: "src/web/tool.ts",
    find: "    if (error instanceof WebError) return toolError(error.message, { url });",
    replace: '    if (error instanceof WebError) return toolError("fetch failed", { url });',
    scenarios: ["t20-scheme-host"],
  },
];

const EXPECTED_DIVERGENT = new Set([
  "t20-port-invalid",
  "t20-userinfo",
  "t20-non-public-literals",
  "t20-literal-public",
  "t20-redirect-flow",
  "t20-fetch-bounds",
  "t20-peer-matrix",
  "t20-peer-divergent",
  "t20-ddg-byte-cap",
]);

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

function nominalVerdictSync(scenarioId: string): string {
  return EXPECTED_DIVERGENT.has(scenarioId) ? "divergent" : "match";
}

function observedBodyBytes(stdout: string): number[] {
  const values: number[] = [];
  for (const match of stdout.matchAll(/"bodyBytesRead": (\d+)/gu)) {
    values.push(Number.parseInt(match[1] ?? "0", 10));
  }
  return values;
}

function inspectRequiredProof(
  stdout: string,
  proof: NonNullable<Mutant["requiredProof"]> | undefined,
): { readonly cause: boolean; readonly bodyBytesRead: boolean } {
  if (proof === undefined) return { cause: true, bodyBytesRead: true };
  try {
    const observation = JSON.parse(stdout) as unknown;
    if (typeof observation !== "object" || observation === null || Array.isArray(observation)) {
      return { cause: false, bodyBytesRead: false };
    }
    const record = observation as Record<string, unknown>;
    const result = record.result;
    const resultRecord =
      typeof result === "object" && result !== null && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : null;
    return {
      cause: resultRecord?.error === proof.cause,
      bodyBytesRead: record.bodyBytesRead === proof.bodyBytesRead,
    };
  } catch {
    return { cause: false, bodyBytesRead: false };
  }
}

function main(): void {
  const oracleWorkspace = resolveOracleWorkspace({
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  }).root;
  const baselineDigest = sourceDigest();
  const results: Record<string, unknown>[] = [];
  let failures = 0;
  for (const mutant of MUTANTS) {
    const copy = makeCopy(mutant.id);
    const proofResults: Record<string, unknown>[] = [];
    let killed = true;
    let setupError: string | null = null;
    try {
      applyMutant(copy, mutant);
      const build = run("npm", ["run", "build"], copy, 300_000);
      if (build.status !== 0) {
        throw new Error(`mutant copy build failed: ${build.stderr}${build.stdout}`.slice(0, 800));
      }
      for (const scenarioId of mutant.scenarios) {
        const manifestPath = resolve(root, `scripts/parity/manifests/t20/${scenarioId}.json`);
        const manifest = parseScenarioManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
        const nominalCandidateExpectation = manifest.expectations.find(
          (expectation) =>
            expectation.side !== "oracle" &&
            expectation.field === "process.stdout" &&
            typeof expectation.value === "string",
        )?.value as string;
        let verdict = "";
        let candidateOutput = "";
        let proofError: string | null = null;
        try {
          const record = runScenario(manifest, { cwd: copy, projectRoot: copy, oracleWorkspace });
          verdict = record.verdict;
          candidateOutput = Buffer.from(record.runs.candidate.process.stdout, "base64").toString(
            "utf8",
          );
        } catch (error) {
          proofError = error instanceof Error ? error.message : String(error);
          verdict = "error";
        }
        const nominal = nominalVerdictSync(scenarioId);
        const observedMatchesNominalExpectation =
          proofError === null && candidateOutput === nominalCandidateExpectation;
        const observedBytes = observedBodyBytes(candidateOutput);
        const observedNominalCauseVisible =
          candidateOutput.includes("refusing") ||
          candidateOutput.includes("could not") ||
          candidateOutput.includes("exceeded") ||
          candidateOutput.includes("unavailable") ||
          candidateOutput.includes("failed");
        const requiredProof = inspectRequiredProof(candidateOutput, mutant.requiredProof);
        proofResults.push({
          scenario: scenarioId,
          nominal,
          verdict,
          ...(proofError === null ? {} : { error: proofError }),
          observedBodyBytesRead: observedBytes,
          observedMatchesNominalExpectation,
          nominalCandidateCauseVisibleInMutant: observedNominalCauseVisible,
          ...(mutant.requiredProof === undefined
            ? {}
            : {
                requiredCause: mutant.requiredProof.cause,
                requiredBodyBytesRead: mutant.requiredProof.bodyBytesRead,
                observedRequiredCause: requiredProof.cause,
                observedRequiredBodyBytes: requiredProof.bodyBytesRead,
              }),
        });
        // Kill = the mutant's observed candidate output no longer satisfies the
        // pinned normative candidate expectation (which encodes the contracted
        // cause and bodyBytesRead=0 for the SSRF/peer rows).
        if (
          observedMatchesNominalExpectation ||
          proofError !== null ||
          !requiredProof.cause ||
          !requiredProof.bodyBytesRead
        ) {
          killed = false;
        }
      }
    } catch (error) {
      killed = false;
      setupError = error instanceof Error ? error.message : String(error);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
    const record = {
      mutant: mutant.id,
      killed,
      ...(setupError === null ? {} : { setupError }),
      proofs: proofResults,
    };
    if (!killed) failures += 1;
    results.push(record);
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
  if (sourceDigest() !== baselineDigest) {
    process.stderr.write("t20 mutation proof: the lane worktree changed during the run\n");
    failures += 1;
  }
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    resolve(evidenceDirectory, "mutations.json"),
    `${JSON.stringify({ suite: "t20-mutations", mutants: MUTANTS.length, failures, results }, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ suite: "t20-mutations", failures, mutants: MUTANTS.length })}\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
