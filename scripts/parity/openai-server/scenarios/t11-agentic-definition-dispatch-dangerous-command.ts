// Assertion 56: with `terminal` allow-listed (agentic mode, --tools
// terminal), an attempted `rm -rf /` never executes and the tool result
// sent back upstream is exactly `subagent auto-denied a dangerous command
// (recursive delete (rm -r))`, carrying the `command` field. An external
// canary file proves the command never actually ran.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FakeUpstream, UpstreamRequestRecord } from "../fake-upstream.js";
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

const DENIAL_MESSAGE = "subagent auto-denied a dangerous command (recursive delete (rm -r))";
const CANARY_CONTENT = "T11_DANGEROUS_COMMAND_CANARY_UNTOUCHED";

function postRequestLines(apiKey: string | null, body: string): string {
  return (
    "POST /v1/chat/completions HTTP/1.1\n" +
    "Host: 127.0.0.1\n" +
    "Content-Type: application/json\n" +
    `Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\n` +
    `Authorization: Bearer ${apiKey ?? ""}\n` +
    "Connection: close\n"
  );
}

function toolResultMessage(record: UpstreamRequestRecord): Record<string, unknown> | undefined {
  const messages = record.body["messages"];
  if (!Array.isArray(messages)) return undefined;
  return messages.find((message) => (message as Record<string, unknown> | undefined)?.["role"] === "tool") as
    | Record<string, unknown>
    | undefined;
}

export async function run(
  oracle: ServerHandle,
  candidate: ServerHandle,
  upstream: FakeUpstream,
): Promise<{
  projection: unknown;
  rawEvidence: unknown;
  match: boolean;
  differences: unknown[];
  expectedUpstreamRequests: number;
}> {
  const canaryOraclePath = join(oracle.paths.tmp, "dangerous-command-canary.txt");
  const canaryCandidatePath = join(candidate.paths.tmp, "dangerous-command-canary.txt");
  writeFileSync(canaryOraclePath, CANARY_CONTENT, "utf8");
  writeFileSync(canaryCandidatePath, CANARY_CONTENT, "utf8");

  const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "SCEN:toolcall-danger hi" }] });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth("dangerous-command", oracle, candidate, (apiKey) => postRequestLines(apiKey, body), body)),
    upstream: upstream.requests.slice(before),
  };

  const canaryOracleIntact = readFileSync(canaryOraclePath, "utf8") === CANARY_CONTENT;
  const canaryCandidateIntact = readFileSync(canaryCandidatePath, "utf8") === CANARY_CONTENT;

  const rawEvidence = { request: probe.request, oracle: probe.oracle, candidate: probe.candidate, upstream: probe.upstream };

  const secondCallOracle = probe.upstream.find((record, index) => index > 0 && toolResultMessage(record) !== undefined);
  const toolMessages = probe.upstream.map((record) => toolResultMessage(record)).filter((message) => message !== undefined);

  const denialShapeOk = toolMessages.every((message) => {
    const content = message["content"];
    if (typeof content !== "string") return false;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return false;
    }
    return parsed["error"] === DENIAL_MESSAGE && parsed["command"] === "rm -rf /";
  });

  const comparison = compareRaw(probe.oracle, probe.candidate, {
    oracleBody: probe.oracle.body.replaceAll(/"id":"chatcmpl-[0-9a-f]{32}"/gu, '"id":"<ID>"').replaceAll(/"created":\d+/gu, '"created":0'),
    candidateBody: probe.candidate.body.replaceAll(/"id":"chatcmpl-[0-9a-f]{32}"/gu, '"id":"<ID>"').replaceAll(/"created":\d+/gu, '"created":0'),
  });

  const checks = {
    statusOk: probe.oracle.statusLine.includes(" 200 ") && probe.candidate.statusLine.includes(" 200 "),
    toolResultCountOk: toolMessages.length === 2,
    denialShapeOk,
    canaryOracleIntactOk: canaryOracleIntact,
    canaryCandidateIntactOk: canaryCandidateIntact,
    upstreamCountOk: probe.upstream.length === 4,
    bilateralOk: comparison.match,
  };
  const ok = Object.values(checks).every(Boolean) && secondCallOracle !== undefined;
  const record = { id: probe.id, checks, normalized: { oracle: comparison.oracle, candidate: comparison.candidate }, match: ok };
  const differences = ok ? [] : [record];

  return {
    projection: {
      probes: [record],
      normalizations: [
        { path: "/v1/chat/completions", rule: "`id`/`created` normalized before the bilateral diff." },
        { path: "*", rule: "`date`/`server` headers dropped; header order not compared." },
      ],
    },
    rawEvidence,
    match: ok,
    differences,
    expectedUpstreamRequests: 4,
  };
}
