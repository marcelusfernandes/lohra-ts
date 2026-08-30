// Assertions 29 (compact JSON, upstream 418 + canary preserved through the
// 502), 29a (temperature/max_tokens land verbatim in the captured upstream
// request), 30 (chat.completion envelope shape) and 32 (finish_reason
// length for a partial turn, stop for a complete one).
import { CAUSE_CANARY, type FakeUpstream, type UpstreamRequestRecord } from "../fake-upstream.js";
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

const CHATCMPL_ID = /^chatcmpl-[0-9a-f]{32}$/u;

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

/** Assertion 30/33: `id`/`created` are format-checked (32-hex `chatcmpl-`
 * id; integer `created`) then zeroed for the bilateral body diff — the
 * exact values are per-process-run and never expected to match across
 * oracle/candidate, only their SHAPE is. */
function normalizeEnvelope(body: string): { text: string; shapeOk: boolean } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { text: body, shapeOk: false };
  }
  const id = parsed["id"];
  const created = parsed["created"];
  const shapeOk =
    typeof id === "string" &&
    CHATCMPL_ID.test(id) &&
    typeof created === "number" &&
    Number.isInteger(created) &&
    parsed["object"] === "chat.completion";
  parsed["id"] = "<ID>";
  parsed["created"] = 0;
  return { text: JSON.stringify(parsed), shapeOk };
}

function upstreamBodyOk(record: UpstreamRequestRecord | undefined, expected: Record<string, unknown>): boolean {
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
  const probes: (ProbeRecord & { upstream: UpstreamRequestRecord[]; expectedStatus: number })[] = [];

  const successBody = JSON.stringify({
    model: "m",
    messages: [{ role: "user", content: "SCEN:ok hi" }],
    temperature: 0.25,
    max_tokens: 321,
  });
  const before1 = upstream.requests.length;
  const success = await probeBoth("success", oracle, candidate, (apiKey) => postRequestLines(apiKey, successBody), successBody);
  probes.push({ ...success, upstream: upstream.requests.slice(before1), expectedStatus: 200 });

  const partialBody = JSON.stringify({ model: "m", messages: [{ role: "user", content: "SCEN:partial hi" }] });
  const before2 = upstream.requests.length;
  const partial = await probeBoth("partial", oracle, candidate, (apiKey) => postRequestLines(apiKey, partialBody), partialBody);
  probes.push({ ...partial, upstream: upstream.requests.slice(before2), expectedStatus: 200 });

  const errorBody = JSON.stringify({ model: "m", messages: [{ role: "user", content: "SCEN:err418 hi" }] });
  const before3 = upstream.requests.length;
  const upstreamError = await probeBoth("upstream-error", oracle, candidate, (apiKey) => postRequestLines(apiKey, errorBody), errorBody);
  probes.push({ ...upstreamError, upstream: upstream.requests.slice(before3), expectedStatus: 502 });

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
    const shapeOk = entry.expectedStatus !== 200 || (oracleNorm.shapeOk && candidateNorm.shapeOk);
    const causeOk =
      entry.expectedStatus !== 502 ||
      (entry.oracle.body.includes("418") &&
        entry.oracle.body.includes(CAUSE_CANARY) &&
        entry.candidate.body.includes("418") &&
        entry.candidate.body.includes(CAUSE_CANARY));
    const upstreamCountOk = entry.upstream.length === 2;
    const upstreamMappingOk =
      !isSuccess || (upstreamBodyOk(entry.upstream[0], { temperature: 0.25, max_tokens: 321 }) && upstreamBodyOk(entry.upstream[1], { temperature: 0.25, max_tokens: 321 }));
    const finishReasonOk =
      !isPartial ||
      (entry.oracle.body.includes('"finish_reason":"length"') && entry.candidate.body.includes('"finish_reason":"length"'));
    const ok = comparison.match && statusOk && shapeOk && causeOk && upstreamCountOk && upstreamMappingOk && finishReasonOk;
    const record = {
      id: entry.id,
      expectedStatus: entry.expectedStatus,
      normalized: { oracle: comparison.oracle, candidate: comparison.candidate },
      checks: { statusOk, shapeOk, causeOk, upstreamCountOk, upstreamMappingOk, finishReasonOk },
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
        { path: "/v1/chat/completions", rule: "`id` checked against chatcmpl-<32hex> then set to <ID>; `created` checked to be an integer then zeroed (assertion 30/33)." },
        { path: "*", rule: "`date`/`server` headers dropped; header order not compared." },
      ],
    },
    rawEvidence,
    match,
    differences,
    expectedUpstreamRequests: 6,
  };
}
