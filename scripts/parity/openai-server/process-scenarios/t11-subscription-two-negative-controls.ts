// Assertion 60: the subscription gate does NOT fire when
// acknowledged_tos_risk:false, nor when auth_mode:"api_key" — in both
// controls the listener comes up and /health responds. Uses `startServer`
// (which waits for LISTEN and would throw on refusal) rather than
// `runProcessToCompletion`, since these two cases are expected to succeed.
import { sendRaw, startServer, stopAndCleanup } from "../harness.js";
import type { FakeUpstream } from "../fake-upstream.js";
import type { ProcessScenarioResult } from "../run-process.js";

async function healthOk(port: number): Promise<boolean> {
  const response = await sendRaw(
    port,
    "GET /health HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n",
  );
  return (
    response.statusLine.includes(" 200 ") && response.body === '{"ok":true,"version":"0.0.11"}'
  );
}

export async function run(upstream: FakeUpstream): Promise<ProcessScenarioResult> {
  const notAcknowledged = await startServer(
    "candidate",
    { seedAuth: { authMode: "subscription", acknowledgedTosRisk: false, preference: "auto" } },
    upstream.url,
  );
  const notAcknowledgedHealthOk = await healthOk(notAcknowledged.port);
  await stopAndCleanup(notAcknowledged);

  const apiKeyMode = await startServer(
    "candidate",
    { seedAuth: { authMode: "api_key", acknowledgedTosRisk: true, preference: "auto" } },
    upstream.url,
  );
  const apiKeyModeHealthOk = await healthOk(apiKeyMode.port);
  await stopAndCleanup(apiKeyMode);

  const checks = {
    // Both `startServer` calls already proved the listener came up (they
    // await LISTEN and throw T11_SERVER_DID_NOT_START otherwise).
    notAcknowledgedListenedAndHealthyOk: notAcknowledgedHealthOk,
    apiKeyModeListenedAndHealthyOk: apiKeyModeHealthOk,
  };
  const match = Object.values(checks).every(Boolean);

  const record = { id: "subscription-two-negative-controls", checks, match };
  return {
    projection: { probes: [{ id: record.id, checks, match }] },
    rawEvidence: [record],
    match,
    differences: match ? [] : [record],
  };
}
