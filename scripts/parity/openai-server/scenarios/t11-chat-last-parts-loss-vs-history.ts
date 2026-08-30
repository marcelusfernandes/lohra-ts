// Assertion 26 (chat half): the LAST chat message's `content` as a
// parts/list is lost — the upstream receives "" for it — while the SAME
// shape of list earlier in history is preserved verbatim. The Responses
// half (no loss, parts concatenated) lives in
// t11-responses-parts-concatenation.ts.
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

const HISTORY_PARTS = [{ type: "text", text: "earlier-h1" }];
const LAST_PARTS = [{ type: "text", text: "SCEN:ok last-parts" }];

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
  const body = JSON.stringify({
    model: "m",
    messages: [
      { role: "user", content: HISTORY_PARTS },
      { role: "assistant", content: "ack" },
      { role: "user", content: LAST_PARTS },
    ],
  });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth("last-parts-lost", oracle, candidate, (apiKey) => postRequestLines(apiKey, body), body)),
    upstream: upstream.requests.slice(before),
  };

  const rawEvidence = { request: probe.request, oracle: probe.oracle, candidate: probe.candidate, upstream: probe.upstream };

  const comparison = compareRaw(probe.oracle, probe.candidate, {
    oracleBody: probe.oracle.body.replaceAll(/"id":"chatcmpl-[0-9a-f]{32}"/gu, '"id":"<ID>"').replaceAll(/"created":\d+/gu, '"created":0'),
    candidateBody: probe.candidate.body.replaceAll(/"id":"chatcmpl-[0-9a-f]{32}"/gu, '"id":"<ID>"').replaceAll(/"created":\d+/gu, '"created":0'),
  });

  const lastLostOk = probe.upstream.every((record) => {
    const messages = record.body["messages"];
    const last = Array.isArray(messages) ? (messages.at(-1) as Record<string, unknown> | undefined) : undefined;
    return last?.["content"] === "";
  });
  // The system prompt is prepended ahead of the client's own messages, so
  // the history entry under test is found by matching its content shape,
  // not by a fixed index.
  const expectedHistoryContent = JSON.stringify(HISTORY_PARTS);
  const historyPreservedOk = probe.upstream.every((record) => {
    const messages = record.body["messages"];
    if (!Array.isArray(messages)) return false;
    return messages.some((message: unknown) => {
      const content: unknown = (message as Record<string, unknown>)["content"];
      return JSON.stringify(content) === expectedHistoryContent;
    });
  });
  const upstreamCountOk = probe.upstream.length === 2;

  const checks = { bilateralOk: comparison.match, lastLostOk, historyPreservedOk, upstreamCountOk };
  const match = Object.values(checks).every(Boolean);
  const record = { id: probe.id, checks, match };
  const differences = match ? [] : [{ ...record, normalized: { oracle: comparison.oracle, candidate: comparison.candidate } }];

  return {
    projection: {
      probes: [record],
      normalizations: [
        { path: "/v1/chat/completions", rule: "`id`/`created` normalized before the bilateral body diff." },
        { path: "*", rule: "`date`/`server` headers dropped; header order not compared." },
      ],
    },
    rawEvidence,
    match,
    differences,
    expectedUpstreamRequests: 2,
  };
}
