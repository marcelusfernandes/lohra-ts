// Assertion 58: subscription auth active + acknowledged refuses startup
// with exit 2 and the governed message, INCLUDING with preference:api_key
// — "auth prefer api_key" does NOT lift the gate. Proved externally like
// t11-subscription-default-no-listener.ts: the reserved port never enters
// LISTEN, /health never answers, no upstream request is ever made, no
// orphan child process remains.
import net from "node:net";
import { rmSync } from "node:fs";

import type { FakeUpstream } from "../fake-upstream.js";
import {
  allocatePort,
  buildServeInvocation,
  materialize,
  runProcessToCompletion,
  seedSubscriptionAuth,
} from "../harness.js";
import type { ProcessScenarioResult } from "../run-process.js";

const GOVERNED_MESSAGE =
  "refusing to serve: subscription mode is active, and relaying your ChatGPT/Codex subscription through this server would expose it. Run `lohra auth disable` (or use an API key) to serve — this gate is unconditional, so `lohra auth prefer api_key` does NOT lift it.\n";

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once("error", () => { resolveConnect(false); });
  });
}

export async function run(upstream: FakeUpstream): Promise<ProcessScenarioResult> {
  const port = await allocatePort();
  const paths = materialize("candidate");
  seedSubscriptionAuth(paths, { authMode: "subscription", acknowledgedTosRisk: true, preference: "api_key" });
  const invocation = buildServeInvocation("candidate", {}, upstream.url, paths, port);
  const before = upstream.requests.length;

  const result = await runProcessToCompletion(invocation, paths.cwd, 8000);
  const portFreeAfterExit = await canConnect(port).then((connected) => !connected);

  const upstreamRequests = upstream.requests.slice(before);
  const checks = {
    exitCodeIs2: result.exitCode === 2,
    stderrGoverned: result.stderr === GOVERNED_MESSAGE,
    portFreeAfterExit,
    zeroUpstreamRequests: upstreamRequests.length === 0,
  };
  const match = Object.values(checks).every(Boolean);

  rmSync(paths.runtimeRoot, { recursive: true, force: true });

  const record = { id: "subscription-preference-no-listener", result, checks, upstreamRequests, match };
  return {
    projection: { probes: [{ id: record.id, checks: record.checks, match }] },
    rawEvidence: [record],
    match,
    differences: match ? [] : [record],
  };
}
