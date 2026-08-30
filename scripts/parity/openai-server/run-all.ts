#!/usr/bin/env node
// T11 [socket-bilateral] orchestrator: real oracle Python and candidate Node
// `serve` processes on ephemeral loopback ports, probed over raw HTTP/1.1
// sockets, upstream calls trapped by one shared fake-upstream server. See
// contract-t11 "## 24 cenários [socket-bilateral]" for the full list; this
// file wires them in one process-per-scenario-config group and writes
// versioned evidence under .parity-evidence/t11/.
import { createHash } from "node:crypto";

import { startFakeUpstream } from "./fake-upstream.js";
import {
  runGuards,
  startServer,
  stopAndCleanup,
  writeEvidence,
  type ServerConfig,
  type ServerHandle,
} from "./harness.js";
import { run as surfaceHealthModelsDocs } from "./scenarios/t11-surface-health-models-docs.js";

interface ScenarioSpec {
  readonly id: string;
  readonly config: ServerConfig;
  readonly run: (oracle: ServerHandle, candidate: ServerHandle) => Promise<{
    projection: unknown;
    match: boolean;
    differences: unknown[];
  }>;
}

const SCENARIOS: readonly ScenarioSpec[] = [
  { id: "t11-surface-health-models-docs", config: {}, run: surfaceHealthModelsDocs },
];

const guards = runGuards();
const upstream = await startFakeUpstream();

let failures = 0;
const projections: { id: string; sha: string; match: boolean }[] = [];

try {
  for (const scenario of SCENARIOS) {
    upstream.requests.length = 0;
    const oracle = await startServer("oracle", scenario.config, upstream.url);
    const candidate = await startServer("candidate", scenario.config, upstream.url);
    let result;
    try {
      result = await scenario.run(oracle, candidate);
    } finally {
      await Promise.all([stopAndCleanup(oracle), stopAndCleanup(candidate)]);
    }
    if (!result.match) failures += 1;
    const sha = createHash("sha256").update(JSON.stringify(result.projection)).digest("hex");
    projections.push({ id: scenario.id, sha, match: result.match });
    writeEvidence(scenario.id, {
      schemaVersion: 1,
      id: scenario.id,
      targetSha: guards.targetSha,
      oracleCommit: guards.oracleCommit,
      config: scenario.config,
      projection: result.projection,
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
  `${JSON.stringify({ suite: "t11-openai-server-socket-bilateral", scenarios: projections.length, failures, digest, projections })}\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
