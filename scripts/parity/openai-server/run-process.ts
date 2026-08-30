#!/usr/bin/env node
// T11 [processo-ts] orchestrator: the REAL packaged CLI (dist/cli.js — the
// exact file package.json's `bin.lohra` points at), an ephemeral port, and
// the process observed externally (exit code, stderr, whether the port
// ever entered LISTEN, whether the shared fake upstream ever saw a
// request). Candidate-only — this layer proves startup/subscription/
// listener/signal/cleanup gates, not oracle/candidate parity.
import { createHash } from "node:crypto";

import { startFakeUpstream, type FakeUpstream } from "./fake-upstream.js";
import { evidenceRoot, runGuards, writeEvidence } from "./harness.js";
import { run as insecureAndEnvKeyStartup } from "./process-scenarios/t11-insecure-and-env-key-startup.js";
import { run as occupiedPortRefusal } from "./process-scenarios/t11-occupied-port-refusal.js";
import { run as subscriptionDefaultNoListener } from "./process-scenarios/t11-subscription-default-no-listener.js";
import { run as subscriptionInsecureNoListener } from "./process-scenarios/t11-subscription-insecure-no-listener.js";
import { run as subscriptionPreferenceNoListener } from "./process-scenarios/t11-subscription-preference-no-listener.js";
import { run as subscriptionTwoNegativeControls } from "./process-scenarios/t11-subscription-two-negative-controls.js";

export interface ProcessScenarioResult {
  readonly projection: unknown;
  readonly rawEvidence: unknown;
  readonly match: boolean;
  readonly differences: unknown[];
}

interface ProcessScenarioSpec {
  readonly id: string;
  readonly run: (upstream: FakeUpstream) => Promise<ProcessScenarioResult>;
}

const SCENARIOS: readonly ProcessScenarioSpec[] = [
  { id: "t11-insecure-and-env-key-startup", run: insecureAndEnvKeyStartup },
  { id: "t11-subscription-default-no-listener", run: subscriptionDefaultNoListener },
  { id: "t11-subscription-preference-no-listener", run: subscriptionPreferenceNoListener },
  { id: "t11-subscription-insecure-no-listener", run: subscriptionInsecureNoListener },
  { id: "t11-subscription-two-negative-controls", run: subscriptionTwoNegativeControls },
  { id: "t11-occupied-port-refusal", run: occupiedPortRefusal },
];

const guards = runGuards();
const upstream = await startFakeUpstream();

let failures = 0;
const projections: { id: string; sha: string; match: boolean }[] = [];

try {
  for (const scenario of SCENARIOS) {
    upstream.requests.length = 0;
    const result = await scenario.run(upstream);
    if (!result.match) failures += 1;
    const sha = createHash("sha256").update(JSON.stringify(result.projection)).digest("hex");
    projections.push({ id: scenario.id, sha, match: result.match });
    writeEvidence(scenario.id, {
      schemaVersion: 1,
      id: scenario.id,
      targetSha: guards.targetSha,
      oracleCommit: guards.oracleCommit,
      projection: result.projection,
      rawEvidence: result.rawEvidence,
      differences: result.differences,
      projectionSha256: sha,
    });
  }
} finally {
  await upstream.close();
}

const digest = createHash("sha256")
  .update(projections.map(({ id, sha }) => `${id}=${sha}\n`).join(""))
  .digest("hex");
process.stdout.write(
  `${JSON.stringify({ suite: "t11-openai-server-processo-ts", scenarios: projections.length, failures, digest, projections, evidenceRoot })}\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
