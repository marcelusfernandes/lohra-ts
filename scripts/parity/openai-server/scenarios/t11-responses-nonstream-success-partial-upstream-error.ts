// Assertions 29 (compact JSON, upstream 418 + canary preserved through the
// 502), 29a (Responses renames max_output_tokens:77 -> max_tokens:77 in the
// captured upstream request), 31 (id/item-id shape, the 15-field envelope —
// see erratum note in t11-responses-stream-success-no-done.ts) and 32
// (Responses uses status:"completed" and incomplete_details:null even for a
// partial turn — never finish_reason:length like chat).
import { CAUSE_CANARY, type FakeUpstream, type UpstreamRequestRecord } from "../fake-upstream.js";
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

const RESP_ID = /^resp_[0-9a-f]{32}$/u;

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

function normalizeEnvelope(body: string): { text: string; shapeOk: boolean; itemIdOk: boolean } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { text: body, shapeOk: false, itemIdOk: false };
  }
  const id = parsed["id"];
  const createdAt = parsed["created_at"];
  const output = Array.isArray(parsed["output"])
    ? (parsed["output"] as Record<string, unknown>[])
    : [];
  const itemId = output[0]?.["id"];
  const shapeOk =
    typeof id === "string" &&
    RESP_ID.test(id) &&
    typeof createdAt === "number" &&
    Number.isInteger(createdAt) &&
    parsed["object"] === "response" &&
    Object.keys(parsed).length === 15;
  const itemIdOk = typeof id === "string" && itemId === `msg_resp_${id.slice("resp_".length)}`;
  parsed["id"] = "<ID>";
  parsed["created_at"] = 0;
  if (output[0] !== undefined) output[0]["id"] = "<ITEM-ID>";
  return { text: JSON.stringify(parsed), shapeOk, itemIdOk };
}

function upstreamBodyOk(
  record: UpstreamRequestRecord | undefined,
  expected: Record<string, unknown>,
): boolean {
  if (record === undefined) return false;
  return Object.entries(expected).every(([key, value]) => record.body[key] === value);
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
  const probes: (ProbeRecord & { upstream: UpstreamRequestRecord[]; expectedStatus: number })[] =
    [];

  const successBody = JSON.stringify({
    model: "m",
    input: "SCEN:ok hi",
    temperature: 0.25,
    max_output_tokens: 77,
  });
  const before1 = upstream.requests.length;
  const success = await probeBoth(
    "success",
    oracle,
    candidate,
    (apiKey) => postRequestLines(apiKey, successBody),
    successBody,
  );
  probes.push({ ...success, upstream: upstream.requests.slice(before1), expectedStatus: 200 });

  const partialBody = JSON.stringify({ model: "m", input: "SCEN:partial hi" });
  const before2 = upstream.requests.length;
  const partial = await probeBoth(
    "partial",
    oracle,
    candidate,
    (apiKey) => postRequestLines(apiKey, partialBody),
    partialBody,
  );
  probes.push({ ...partial, upstream: upstream.requests.slice(before2), expectedStatus: 200 });

  const errorBody = JSON.stringify({ model: "m", input: "SCEN:err418 hi" });
  const before3 = upstream.requests.length;
  const upstreamError = await probeBoth(
    "upstream-error",
    oracle,
    candidate,
    (apiKey) => postRequestLines(apiKey, errorBody),
    errorBody,
  );
  probes.push({
    ...upstreamError,
    upstream: upstream.requests.slice(before3),
    expectedStatus: 502,
  });

  const rawEvidence = probes.map((entry) => ({
    id: entry.id,
    request: entry.request,
    oracle: entry.oracle,
    candidate: entry.candidate,
    upstream: entry.upstream,
  }));

  const differences: unknown[] = [];
  const projectedProbes = probes.map((entry) => {
    const isSuccess = entry.id === "success";
    const isPartial = entry.id === "partial";
    const oracleNorm = normalizeEnvelope(entry.oracle.body);
    const candidateNorm = normalizeEnvelope(entry.candidate.body);
    const comparison = compareRaw(entry.oracle, entry.candidate, {
      oracleBody: oracleNorm.text,
      candidateBody: candidateNorm.text,
    });
    const statusOk =
      entry.oracle.statusLine.includes(` ${String(entry.expectedStatus)} `) &&
      entry.candidate.statusLine.includes(` ${String(entry.expectedStatus)} `);
    const shapeOk =
      entry.expectedStatus !== 200 ||
      (oracleNorm.shapeOk &&
        candidateNorm.shapeOk &&
        oracleNorm.itemIdOk &&
        candidateNorm.itemIdOk);
    const causeOk =
      entry.expectedStatus !== 502 ||
      (entry.oracle.body.includes("418") &&
        entry.oracle.body.includes(CAUSE_CANARY) &&
        entry.candidate.body.includes("418") &&
        entry.candidate.body.includes(CAUSE_CANARY));
    const upstreamCountOk = entry.upstream.length === 2;
    // Assertion 29a: Responses renames max_output_tokens -> max_tokens on
    // the wire to the upstream chat-completions-shaped provider.
    const upstreamMappingOk =
      !isSuccess ||
      (upstreamBodyOk(entry.upstream[0], { temperature: 0.25, max_tokens: 77 }) &&
        upstreamBodyOk(entry.upstream[1], { temperature: 0.25, max_tokens: 77 }) &&
        entry.upstream.every((record) => !("max_output_tokens" in record.body)));
    // Assertion 32: Responses never uses finish_reason:length for a partial
    // turn — status stays "completed", incomplete_details stays null.
    const partialShapeOk =
      !isPartial ||
      (entry.oracle.body.includes('"status":"completed"') &&
        entry.oracle.body.includes('"incomplete_details":null') &&
        entry.candidate.body.includes('"status":"completed"') &&
        entry.candidate.body.includes('"incomplete_details":null'));
    const ok =
      comparison.match &&
      statusOk &&
      shapeOk &&
      causeOk &&
      upstreamCountOk &&
      upstreamMappingOk &&
      partialShapeOk;
    const record = {
      id: entry.id,
      expectedStatus: entry.expectedStatus,
      normalized: { oracle: comparison.oracle, candidate: comparison.candidate },
      checks: { statusOk, shapeOk, causeOk, upstreamCountOk, upstreamMappingOk, partialShapeOk },
      match: ok,
    };
    if (!ok) differences.push(record);
    return record;
  });

  const match = differences.length === 0;
  return {
    projection: {
      probes: projectedProbes,
      normalizations: [
        {
          path: "/v1/responses",
          rule: "`id` checked against resp_<32hex> then set to <ID>; `created_at` checked to be an integer then zeroed; item `id` checked against msg_resp_<same-hex> then set to <ITEM-ID>; envelope key count checked to be 15 (assertion 31 erratum, same authority as t11-responses-stream-success-no-done).",
        },
        { path: "*", rule: "`date`/`server` headers dropped; header order not compared." },
      ],
    },
    rawEvidence,
    match,
    differences,
    expectedUpstreamRequests: 6,
  };
}
