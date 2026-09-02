// Assertion 66's second half: "SIGINT sai 0 ... e libera a porta para bind
// imediato." Every other scenario incidentally exercises SIGINT shutdown
// via harness.ts's stopAndCleanup, but none of them assert on it or prove
// the port is immediately reusable — this scenario does both explicitly,
// for both real processes.
import net from "node:net";

import type { FakeUpstream } from "../fake-upstream.js";
import { sendRaw, type ServerHandle } from "../harness.js";

function canBindImmediately(port: number): Promise<boolean> {
  return new Promise((resolveBind) => {
    const probe = net.createServer();
    probe.once("error", () => { resolveBind(false); });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => { resolveBind(true); });
    });
  });
}

async function healthOk(port: number): Promise<boolean> {
  const response = await sendRaw(port, "GET /health HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n");
  return response.statusLine.includes(" 200 ") && response.body === '{"ok":true,"version":"0.0.11"}';
}

export async function run(
  oracle: ServerHandle,
  candidate: ServerHandle,
  _upstream: FakeUpstream,
): Promise<{
  projection: unknown;
  rawEvidence: unknown;
  match: boolean;
  differences: unknown[];
  expectedUpstreamRequests: number;
}> {
  const oracleUpBefore = await healthOk(oracle.port);
  const candidateUpBefore = await healthOk(candidate.port);

  const [oracleStop, candidateStop] = await Promise.all([oracle.stop("SIGINT"), candidate.stop("SIGINT")]);

  // Immediately, before any temp-dir cleanup — proves the OS-level bind is
  // free the instant the process exits, not just eventually.
  const oraclePortFree = await canBindImmediately(oracle.port);
  const candidatePortFree = await canBindImmediately(candidate.port);

  const checks = {
    wasUpBeforeSigint: oracleUpBefore && candidateUpBefore,
    oracleExitZero: oracleStop.exitCode === 0,
    candidateExitZero: candidateStop.exitCode === 0,
    oraclePortFree,
    candidatePortFree,
  };
  const match = Object.values(checks).every(Boolean);
  const record = {
    id: "sigint-cleanup-and-port-reuse",
    oracleStop,
    candidateStop,
    checks,
    match,
  };

  return {
    projection: { probes: [{ id: record.id, checks, match }] },
    rawEvidence: [record],
    match,
    differences: match ? [] : [record],
    expectedUpstreamRequests: 0,
  };
}
