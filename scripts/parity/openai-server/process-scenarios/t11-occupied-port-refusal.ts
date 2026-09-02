// Assertion 67: startup on an occupied port refuses without touching the
// other listener/process, and leaves no auxiliary process of its own.
import net from "node:net";
import { rmSync } from "node:fs";

import type { FakeUpstream } from "../fake-upstream.js";
import { allocatePort, buildServeInvocation, materialize, runProcessToCompletion } from "../harness.js";
import type { ProcessScenarioResult } from "../run-process.js";

function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolveOccupy, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { resolveOccupy(server); });
  });
}

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
  const occupier = await occupyPort(port);

  const paths = materialize("candidate");
  const invocation = buildServeInvocation("candidate", {}, upstream.url, paths, port);
  const before = upstream.requests.length;
  const result = await runProcessToCompletion(invocation, paths.cwd, 8000);
  const upstreamRequests = upstream.requests.slice(before);

  // The occupying server must still be alive and accepting connections —
  // the candidate's failed bind attempt must not have touched it.
  const occupierStillAliveOk = await canConnect(port);

  await new Promise<void>((resolveClose) => { occupier.close(() => { resolveClose(); }); });

  const checks = {
    exitCodeIs2: result.exitCode === 2,
    stderrMentionsPortInUse: result.stderr.includes("already in use"),
    occupierStillAliveOk,
    zeroUpstreamRequests: upstreamRequests.length === 0,
  };
  const match = Object.values(checks).every(Boolean);

  rmSync(paths.runtimeRoot, { recursive: true, force: true });

  const record = { id: "occupied-port-refusal", result, checks, upstreamRequests, match };
  return {
    projection: { probes: [{ id: record.id, checks: record.checks, match }] },
    rawEvidence: [record],
    match,
    differences: match ? [] : [record],
  };
}
