// Assertion 26 (Responses half): `input_text`/`output_text`/`text` parts in
// a Responses input item are CONCATENATED, not lost — unlike chat's last
// message (t11-chat-last-parts-loss-vs-history.ts). Mixed part types (a
// non-text part interleaved) also proves only the three governed types
// contribute text.
import type { FakeUpstream, UpstreamRequestRecord } from "../fake-upstream.js";
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

function postRequestLines(apiKey: string | null, body: string): string {
  return (
    "POST /v1/responses HTTP/1.1\n" +
    "Host: 127.0.0.1\n" +
    "Content-Type: application/json\n" +
    `Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\n` +
    `Authorization: Bearer ${apiKey ?? ""}\n` +
    "Connection: close\n"
  );
}

const EXPECTED_CONCATENATED = "SCEN:ok-a-b-c";

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
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "SCEN:ok-a-" },
          { type: "not_a_governed_type", text: "IGNORED" },
          { type: "output_text", text: "b-" },
          { type: "text", text: "c" },
        ],
      },
    ],
  });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth(
      "parts-concatenated",
      oracle,
      candidate,
      (apiKey) => postRequestLines(apiKey, body),
      body,
    )),
    upstream: upstream.requests.slice(before),
  };

  const rawEvidence = {
    request: probe.request,
    oracle: probe.oracle,
    candidate: probe.candidate,
    upstream: probe.upstream,
  };

  const comparison = compareRaw(probe.oracle, probe.candidate, {
    oracleBody: probe.oracle.body
      .replaceAll(/"id":"resp_[0-9a-f]{32}"/gu, '"id":"<ID>"')
      .replaceAll(/"created_at":\d+/gu, '"created_at":0')
      .replaceAll(/"id":"msg_resp_[0-9a-f]{32}"/gu, '"id":"<ITEM-ID>"'),
    candidateBody: probe.candidate.body
      .replaceAll(/"id":"resp_[0-9a-f]{32}"/gu, '"id":"<ID>"')
      .replaceAll(/"created_at":\d+/gu, '"created_at":0')
      .replaceAll(/"id":"msg_resp_[0-9a-f]{32}"/gu, '"id":"<ITEM-ID>"'),
  });

  const concatenatedOk = probe.upstream.every((record) => {
    const messages = record.body["messages"];
    const last = Array.isArray(messages)
      ? (messages.at(-1) as Record<string, unknown> | undefined)
      : undefined;
    return last?.["content"] === EXPECTED_CONCATENATED;
  });
  const upstreamCountOk = probe.upstream.length === 2;

  const checks = { bilateralOk: comparison.match, concatenatedOk, upstreamCountOk };
  const match = Object.values(checks).every(Boolean);
  const record = { id: probe.id, checks, match };
  const differences = match
    ? []
    : [{ ...record, normalized: { oracle: comparison.oracle, candidate: comparison.candidate } }];

  return {
    projection: {
      probes: [record],
      normalizations: [
        {
          path: "/v1/responses",
          rule: "`id`/`created_at`/item `id` normalized before the bilateral body diff.",
        },
        { path: "*", rule: "`date`/`server` headers dropped; header order not compared." },
      ],
    },
    rawEvidence,
    match,
    differences,
    expectedUpstreamRequests: 2,
  };
}
