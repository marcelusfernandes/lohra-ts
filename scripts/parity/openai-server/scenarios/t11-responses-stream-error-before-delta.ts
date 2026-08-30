// Assertion 48: an upstream error discovered before the first delta (but
// after the SSE stream is already open) preserves the three initial frames
// (created, output_item.added, content_part.added) and ends in
// response.failed, never [DONE]; response.error.message contains the
// upstream status 418 and the T11_CAUSE_<nonce> canary, never a generic
// "server error".
import { CAUSE_CANARY, type FakeUpstream, type UpstreamRequestRecord } from "../fake-upstream.js";
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

interface Frame {
  readonly eventType: string | undefined;
  readonly data: Record<string, unknown>;
}

function parseFrames(body: string): { frames: Frame[]; parseFailed: boolean; hasDone: boolean } {
  const blocks = body.split("\n\n").filter((block) => block.trim().length > 0);
  const frames: Frame[] = [];
  let parseFailed = false;
  let hasDone = false;
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.some((line) => line === "data: [DONE]")) hasDone = true;
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));
    if (dataLine === undefined) {
      parseFailed = true;
      continue;
    }
    try {
      frames.push({ eventType: eventLine?.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown> });
    } catch {
      parseFailed = true;
    }
  }
  return { frames, parseFailed, hasDone };
}

interface Analysis {
  readonly text: string;
  readonly shapeOk: boolean;
  readonly typeSequenceOk: boolean;
  readonly sequenceOk: boolean;
  readonly noDoneOk: boolean;
  readonly errorCauseOk: boolean;
}

function analyze(body: string): Analysis {
  const { frames, parseFailed, hasDone } = parseFrames(body);
  const typeSequenceOk =
    frames.length === 4 &&
    frames[0]?.eventType === "response.created" &&
    frames[1]?.eventType === "response.output_item.added" &&
    frames[2]?.eventType === "response.content_part.added" &&
    frames[3]?.eventType === "response.failed" &&
    frames.every((frame) => frame.eventType === frame.data["type"]);
  const sequenceNumbers = frames.map((frame) => frame.data["sequence_number"]);
  const sequenceOk = sequenceNumbers.every((value, index) => value === index) && sequenceNumbers.length > 0;
  const failedResponse = frames.at(-1)?.data["response"] as Record<string, unknown> | undefined;
  const errorMessageRaw = (failedResponse?.["error"] as Record<string, unknown> | undefined)?.["message"];
  const errorMessage = typeof errorMessageRaw === "string" ? errorMessageRaw : "";
  const errorCauseOk = failedResponse?.["status"] === "failed" && errorMessage.includes("418") && errorMessage.includes(CAUSE_CANARY);
  const responseId = frames[0]?.data["response"] as Record<string, unknown> | undefined;
  const idValue = responseId?.["id"];
  const normalizedFrames = frames.map((frame) => {
    const cloned = JSON.parse(JSON.stringify(frame.data)) as Record<string, unknown>;
    if (typeof idValue === "string") {
      const text = JSON.stringify(cloned).replaceAll(idValue, "<ID>");
      return { eventType: frame.eventType, data: JSON.parse(text) as Record<string, unknown> };
    }
    return frame;
  });
  const text = normalizedFrames
    .map((frame) => {
      const withZeroedCreated = { ...frame.data };
      const nested = withZeroedCreated["response"];
      if (nested !== null && typeof nested === "object" && "created_at" in nested) (nested as Record<string, unknown>)["created_at"] = 0;
      return `event: ${String(frame.eventType)}\ndata: ${JSON.stringify(withZeroedCreated)}`;
    })
    .join("\n\n");
  return {
    text,
    shapeOk: !parseFailed && typeof idValue === "string",
    typeSequenceOk,
    sequenceOk,
    noDoneOk: !hasDone,
    errorCauseOk,
  };
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
  const body = JSON.stringify({ model: "m", input: "SCEN:err418 hi", stream: true });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth("error-before-delta", oracle, candidate, (apiKey) => postRequestLines(apiKey, body), body)),
    upstream: upstream.requests.slice(before),
  };

  const rawEvidence = { request: probe.request, oracle: probe.oracle, candidate: probe.candidate, upstream: probe.upstream };

  const oracleAnalysis = analyze(probe.oracle.body);
  const candidateAnalysis = analyze(probe.candidate.body);
  const comparison = compareRaw(probe.oracle, probe.candidate, {
    oracleBody: oracleAnalysis.text,
    candidateBody: candidateAnalysis.text,
    extraDroppedHeaders: ["content-length"],
  });

  const checks = {
    statusOk: probe.oracle.statusLine.includes(" 200 ") && probe.candidate.statusLine.includes(" 200 "),
    shapeOk: oracleAnalysis.shapeOk && candidateAnalysis.shapeOk,
    typeSequenceOk: oracleAnalysis.typeSequenceOk && candidateAnalysis.typeSequenceOk,
    sequenceOk: oracleAnalysis.sequenceOk && candidateAnalysis.sequenceOk,
    noDoneOk: oracleAnalysis.noDoneOk && candidateAnalysis.noDoneOk,
    errorCauseOk: oracleAnalysis.errorCauseOk && candidateAnalysis.errorCauseOk,
    upstreamCountOk: probe.upstream.length === 2,
    bilateralOk: comparison.match,
  };
  const ok = Object.values(checks).every(Boolean);
  const record = { id: probe.id, checks, normalized: { oracle: comparison.oracle, candidate: comparison.candidate }, match: ok };
  const differences = ok ? [] : [record];

  return {
    projection: {
      probes: [record],
      normalizations: [
        { path: "/v1/responses (stream)", rule: "`id` normalized before the bilateral diff; every `created_at` occurrence zeroed; `sequence_number` compared literally." },
        { path: "*", rule: "`date`/`server` headers dropped; content-length dropped; header order not compared." },
      ],
    },
    rawEvidence,
    match: ok,
    differences,
    expectedUpstreamRequests: 2,
  };
}
