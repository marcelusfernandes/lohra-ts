// Assertion 51: a client-supplied `tools`/`tool_choice` are discarded
// silently — they never appear in the upstream request, in the server's
// own tool definitions, in dispatch, or in the public response. A tool
// named "evil" proves the negative: it must not surface ANYWHERE on the
// wire, on both chat and Responses, in default (relay, no --tools) mode.
import type { FakeUpstream, UpstreamRequestRecord } from "../fake-upstream.js";
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

const EVIL_TOOL = {
  type: "function",
  function: {
    name: "evil",
    description: "a canary tool that must never be offered upstream",
    parameters: {},
  },
};

function postRequestLines(path: string, apiKey: string | null, body: string): string {
  return (
    `POST ${path} HTTP/1.1\n` +
    "Host: 127.0.0.1\n" +
    "Content-Type: application/json\n" +
    `Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\n` +
    `Authorization: Bearer ${apiKey ?? ""}\n` +
    "Connection: close\n"
  );
}

function normalizeIds(body: string): string {
  return body
    .replaceAll(/"id":\s*"(chatcmpl-|msg_resp_|resp_)[0-9a-f]{32}"/gu, '"id":"<ID>"')
    .replaceAll(/"created":\s*\d+/gu, '"created":0')
    .replaceAll(/"created_at":\s*\d+/gu, '"created_at":0');
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
  const checks: Record<string, boolean> = {};
  const rawEntries: Record<string, unknown> = {};

  const chatBody = JSON.stringify({
    model: "m",
    messages: [{ role: "user", content: "SCEN:ok hi" }],
    tools: [EVIL_TOOL],
    tool_choice: "auto",
  });
  const before1 = upstream.requests.length;
  const chatProbe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth(
      "chat-evil-tool",
      oracle,
      candidate,
      (apiKey) => postRequestLines("/v1/chat/completions", apiKey, chatBody),
      chatBody,
    )),
    upstream: upstream.requests.slice(before1),
  };
  rawEntries["chat"] = {
    request: chatProbe.request,
    oracle: chatProbe.oracle,
    candidate: chatProbe.candidate,
    upstream: chatProbe.upstream,
  };
  checks["chatUpstreamNoEvilOk"] = chatProbe.upstream.every(
    (record) => !JSON.stringify(record.body).includes("evil"),
  );
  checks["chatResponseNoEvilOk"] =
    !chatProbe.oracle.body.includes("evil") && !chatProbe.candidate.body.includes("evil");
  const chatComparison = compareRaw(chatProbe.oracle, chatProbe.candidate, {
    oracleBody: normalizeIds(chatProbe.oracle.body),
    candidateBody: normalizeIds(chatProbe.candidate.body),
  });
  checks["chatBilateralOk"] = chatComparison.match;

  const responsesBody = JSON.stringify({
    model: "m",
    input: "SCEN:ok hi",
    tools: [EVIL_TOOL],
    tool_choice: "auto",
  });
  const before2 = upstream.requests.length;
  const responsesProbe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth(
      "responses-evil-tool",
      oracle,
      candidate,
      (apiKey) => postRequestLines("/v1/responses", apiKey, responsesBody),
      responsesBody,
    )),
    upstream: upstream.requests.slice(before2),
  };
  rawEntries["responses"] = {
    request: responsesProbe.request,
    oracle: responsesProbe.oracle,
    candidate: responsesProbe.candidate,
    upstream: responsesProbe.upstream,
  };
  checks["responsesUpstreamNoEvilOk"] = responsesProbe.upstream.every(
    (record) => !JSON.stringify(record.body).includes("evil"),
  );
  checks["responsesResponseNoEvilOk"] =
    !responsesProbe.oracle.body.includes("evil") && !responsesProbe.candidate.body.includes("evil");
  const responsesComparison = compareRaw(responsesProbe.oracle, responsesProbe.candidate, {
    oracleBody: normalizeIds(responsesProbe.oracle.body),
    candidateBody: normalizeIds(responsesProbe.candidate.body),
  });
  checks["responsesBilateralOk"] = responsesComparison.match;

  const differences = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([id, ok]) => ({ id, ok }));
  const match = differences.length === 0;

  return {
    projection: { checks },
    rawEvidence: rawEntries,
    match,
    differences,
    expectedUpstreamRequests: 4,
  };
}
