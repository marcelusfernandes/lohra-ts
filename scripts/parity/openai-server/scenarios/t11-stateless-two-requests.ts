// Assertion 64: each request creates a NEW Agent. Two consecutive requests
// to the same running server send upstream only the frozen system prompt
// plus the CURRENT user turn — no history, usage, tool result or model
// leaked from the prior request.
import type { FakeUpstream, UpstreamRequestRecord } from "../fake-upstream.js";
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

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
  const body1 = JSON.stringify({ model: "model-one", messages: [{ role: "user", content: "SCEN:ok first-request-marker" }] });
  const before1 = upstream.requests.length;
  const probe1: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth("first", oracle, candidate, (apiKey) => postRequestLines(apiKey, body1), body1)),
    upstream: upstream.requests.slice(before1),
  };

  const body2 = JSON.stringify({ model: "model-two", messages: [{ role: "user", content: "SCEN:ok second-request-marker" }] });
  const before2 = upstream.requests.length;
  const probe2: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth("second", oracle, candidate, (apiKey) => postRequestLines(apiKey, body2), body2)),
    upstream: upstream.requests.slice(before2),
  };

  const rawEvidence = {
    first: { request: probe1.request, oracle: probe1.oracle, candidate: probe1.candidate, upstream: probe1.upstream },
    second: { request: probe2.request, oracle: probe2.oracle, candidate: probe2.candidate, upstream: probe2.upstream },
  };

  function messagesOf(record: UpstreamRequestRecord | undefined): Record<string, unknown>[] {
    const messages = record?.body["messages"];
    return Array.isArray(messages) ? (messages as Record<string, unknown>[]) : [];
  }

  const checks: Record<string, boolean> = {};
  checks["upstreamCountOk"] = probe1.upstream.length === 2 && probe2.upstream.length === 2;

  const shapeChecks = [...probe1.upstream, ...probe2.upstream].map((record) => {
    const messages = messagesOf(record);
    return messages.length === 2 && messages[0]?.["role"] === "system" && messages[1]?.["role"] === "user";
  });
  checks["exactlyTwoMessagesOk"] = shapeChecks.every(Boolean);

  const systemPrompts = [...probe1.upstream, ...probe2.upstream].map((record) => messagesOf(record)[0]?.["content"]);
  checks["systemFrozenIdenticalOk"] = new Set(systemPrompts).size === 1;

  function userContent(record: UpstreamRequestRecord): string {
    const content = messagesOf(record)[1]?.["content"];
    return typeof content === "string" ? content : "";
  }
  checks["firstUserContentOk"] = probe1.upstream.every((record) => userContent(record).includes("first-request-marker"));
  checks["secondUserContentOk"] = probe2.upstream.every((record) => userContent(record).includes("second-request-marker"));
  checks["noCrossLeakOk"] =
    probe1.upstream.every((record) => !userContent(record).includes("second-request-marker")) &&
    probe2.upstream.every((record) => !userContent(record).includes("first-request-marker"));

  checks["firstModelOk"] = probe1.upstream.every((record) => record.body["model"] === "model-one");
  checks["secondModelOk"] = probe2.upstream.every((record) => record.body["model"] === "model-two");

  checks["noUsageOrToolInMessagesOk"] = [...probe1.upstream, ...probe2.upstream].every((record) =>
    messagesOf(record).every((message) => message["role"] !== "tool" && !("tool_calls" in message)),
  );

  const comparison1 = compareRaw(probe1.oracle, probe1.candidate, {
    oracleBody: probe1.oracle.body.replaceAll(/"id":"chatcmpl-[0-9a-f]{32}"/gu, '"id":"<ID>"').replaceAll(/"created":\d+/gu, '"created":0'),
    candidateBody: probe1.candidate.body.replaceAll(/"id":"chatcmpl-[0-9a-f]{32}"/gu, '"id":"<ID>"').replaceAll(/"created":\d+/gu, '"created":0'),
  });
  const comparison2 = compareRaw(probe2.oracle, probe2.candidate, {
    oracleBody: probe2.oracle.body.replaceAll(/"id":"chatcmpl-[0-9a-f]{32}"/gu, '"id":"<ID>"').replaceAll(/"created":\d+/gu, '"created":0'),
    candidateBody: probe2.candidate.body.replaceAll(/"id":"chatcmpl-[0-9a-f]{32}"/gu, '"id":"<ID>"').replaceAll(/"created":\d+/gu, '"created":0'),
  });
  checks["bilateralFirstOk"] = comparison1.match;
  checks["bilateralSecondOk"] = comparison2.match;

  const differences = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([id, ok]) => ({ id, ok }));
  const match = differences.length === 0;

  return {
    projection: { checks },
    rawEvidence,
    match,
    differences,
    expectedUpstreamRequests: 4,
  };
}
