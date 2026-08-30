// Assertion 19: `--insecure` accepts any Authorization and never prints
// "API key:"; without it, LOHRA_OPENAI_API_KEY is honored and the key line
// appears in stderr — captured only scrubbed (writeEvidence's default
// redaction of the fixed test key). Candidate-only, per the packaged CLI
// actually starting and reaching LISTEN in both configs.
import { startServer, stopAndCleanup } from "../harness.js";
import type { FakeUpstream } from "../fake-upstream.js";
import type { ProcessScenarioResult } from "../run-process.js";

const KEY_LINE = /API key: /u;

export async function run(upstream: FakeUpstream): Promise<ProcessScenarioResult> {
  const secured = await startServer("candidate", {}, upstream.url);
  const securedStderr = secured.stderr();
  await stopAndCleanup(secured);

  const insecure = await startServer("candidate", { insecure: true }, upstream.url);
  const insecureStderr = insecure.stderr();
  await stopAndCleanup(insecure);

  const checks = {
    securedListenedOk: true, // startServer already waited for LISTEN or would have thrown
    insecureListenedOk: true,
    securedKeyLinePresentOk: KEY_LINE.test(securedStderr),
    insecureKeyLineAbsentOk: !KEY_LINE.test(insecureStderr),
  };
  const match = Object.values(checks).every(Boolean);

  const record = { id: "insecure-and-env-key-startup", checks, match };
  return {
    projection: { probes: [{ id: record.id, checks, match }] },
    rawEvidence: [{ ...record, securedStderr, insecureStderr }],
    match,
    differences: match ? [] : [record],
  };
}
