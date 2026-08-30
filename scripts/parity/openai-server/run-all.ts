#!/usr/bin/env node
// T11 [socket-bilateral] orchestrator: real oracle Python and candidate Node
// `serve` processes on ephemeral loopback ports, probed over raw HTTP/1.1
// sockets, upstream calls trapped by one shared fake-upstream server. See
// contract-t11 "## 24 cenários [socket-bilateral]" for the full list; this
// file wires them in one process-per-scenario-config group and writes
// versioned evidence under .parity-evidence/t11/.
import { createHash } from "node:crypto";

import { startFakeUpstream, type FakeUpstream, type UpstreamRequestRecord } from "./fake-upstream.js";
import {
  runGuards,
  startServer,
  stopAndCleanup,
  writeEvidence,
  type ServerConfig,
  type ServerHandle,
} from "./harness.js";
import { run as bodyValidationBeforeAuthChat } from "./scenarios/t11-body-validation-before-auth-chat.js";
import { run as chatNonstreamSuccessPartialUpstreamError } from "./scenarios/t11-chat-nonstream-success-partial-upstream-error.js";
import { run as chatStreamSuccessUsageAndNoUsage } from "./scenarios/t11-chat-stream-success-usage-and-no-usage.js";
import { run as responsesStreamSuccessNoDone } from "./scenarios/t11-responses-stream-success-no-done.js";
import { run as sigintCleanupAndPortReuse } from "./scenarios/t11-sigint-cleanup-and-port-reuse.js";
import { run as surfaceHealthModelsDocs } from "./scenarios/t11-surface-health-models-docs.js";

interface ScenarioResult {
  readonly projection: unknown;
  readonly rawEvidence: unknown;
  readonly match: boolean;
  readonly differences: unknown[];
  readonly expectedUpstreamRequests: number;
}

interface ScenarioSpec {
  readonly id: string;
  readonly config: ServerConfig;
  readonly run: (oracle: ServerHandle, candidate: ServerHandle, upstream: FakeUpstream) => Promise<ScenarioResult>;
}

const ALL_SCENARIOS: readonly ScenarioSpec[] = [
  { id: "t11-surface-health-models-docs", config: {}, run: surfaceHealthModelsDocs },
  // Evaluator non-blocking note 1 (assertion 16): fallback_models:() must
  // produce exactly {"object":"list","data":[]} — reruns the same surface
  // scenario (health/docs are harmlessly redundant) against a config with
  // no models registered, so the models probe compares two real empty lists.
  { id: "t11-surface-empty-fallback-models", config: { emptyModels: true }, run: surfaceHealthModelsDocs },
  { id: "t11-body-validation-before-auth-chat", config: {}, run: bodyValidationBeforeAuthChat },
  { id: "t11-chat-nonstream-success-partial-upstream-error", config: {}, run: chatNonstreamSuccessPartialUpstreamError },
  { id: "t11-chat-stream-success-usage-and-no-usage", config: {}, run: chatStreamSuccessUsageAndNoUsage },
  { id: "t11-responses-stream-success-no-done", config: {}, run: responsesStreamSuccessNoDone },
  { id: "t11-sigint-cleanup-and-port-reuse", config: {}, run: sigintCleanupAndPortReuse },
];

// T11_ONLY=<id>[,<id>...] restricts the run to named scenarios — dev-only
// iteration speedup so adding scenario N doesn't relaunch every prior
// server pair. Unset (the default, and what parity:t11/CI always use) runs
// the full matrix; determinism (assertion 10) is only proven on that.
const only = (process.env.T11_ONLY ?? "").split(",").map((id) => id.trim()).filter((id) => id.length > 0);
const SCENARIOS = only.length === 0 ? ALL_SCENARIOS : ALL_SCENARIOS.filter((scenario) => only.includes(scenario.id));

const guards = runGuards();
const upstream = await startFakeUpstream();

let failures = 0;
const projections: { id: string; sha: string; match: boolean }[] = [];

try {
  for (const scenario of SCENARIOS) {
    upstream.requests.length = 0;
    const oracle = await startServer("oracle", scenario.config, upstream.url);
    const candidate = await startServer("candidate", scenario.config, upstream.url);
    let result: ScenarioResult;
    let upstreamAtScenarioEnd: UpstreamRequestRecord[];
    let oracleOutput: { stdout: string; stderr: string };
    let candidateOutput: { stdout: string; stderr: string };
    let oracleExit: { exitCode: number | null; signal: NodeJS.Signals | null };
    let candidateExit: { exitCode: number | null; signal: NodeJS.Signals | null };
    try {
      result = await scenario.run(oracle, candidate, upstream);
      upstreamAtScenarioEnd = [...upstream.requests];
      oracleOutput = { stdout: oracle.stdout(), stderr: oracle.stderr() };
      candidateOutput = { stdout: candidate.stdout(), stderr: candidate.stderr() };
    } finally {
      [oracleExit, candidateExit] = await Promise.all([stopAndCleanup(oracle), stopAndCleanup(candidate)]);
    }
    const upstreamCountOk = result.expectedUpstreamRequests === upstreamAtScenarioEnd.length;
    const match = result.match && upstreamCountOk;
    if (!match) failures += 1;
    const sha = createHash("sha256").update(JSON.stringify(result.projection)).digest("hex");
    projections.push({ id: scenario.id, sha, match });
    writeEvidence(scenario.id, {
      schemaVersion: 1,
      id: scenario.id,
      targetSha: guards.targetSha,
      oracleCommit: guards.oracleCommit,
      config: scenario.config,
      projection: result.projection,
      rawEvidence: result.rawEvidence,
      differences: result.differences,
      upstreamRequestCheck: {
        expected: result.expectedUpstreamRequests,
        actual: upstreamAtScenarioEnd.length,
        ok: upstreamCountOk,
        requests: upstreamAtScenarioEnd,
      },
      process: {
        oracle: { ...oracleOutput, ...oracleExit },
        candidate: { ...candidateOutput, ...candidateExit },
      },
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
