// Assertion 49: a transport break AFTER a partial delta (missing chunked
// terminator, not a clean EOF) emits the delta and then response.failed;
// the final response DISCARDS the partial — output:[], output_text:"",
// status:"failed", error.type:"server_error", usage remapped and zeroed.
// This error carries no second HTTP status, so its falsifiable cause is the
// literal break phrase "incomplete chunked read" in error.message — a
// generic "server error" fails this scenario.
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
  readonly hasDeltaBeforeFailedOk: boolean;
  readonly endsWithFailedOk: boolean;
  readonly discardsPartialOk: boolean;
  readonly causeOk: boolean;
  readonly noDoneOk: boolean;
}

function analyze(body: string): Analysis {
  const { frames, parseFailed, hasDone } = parseFrames(body);
  const hasDeltaBeforeFailedOk = frames.some((frame) => frame.eventType === "response.output_text.delta");
  const endsWithFailedOk = frames.at(-1)?.eventType === "response.failed";
  const failedResponse = frames.at(-1)?.data["response"] as Record<string, unknown> | undefined;
  const errorMessageRaw = (failedResponse?.["error"] as Record<string, unknown> | undefined)?.["message"];
  const errorMessage = typeof errorMessageRaw === "string" ? errorMessageRaw : "";
  const errorCode = (failedResponse?.["error"] as Record<string, unknown> | undefined)?.["code"];
  const usage = failedResponse?.["usage"] as Record<string, unknown> | undefined;
  const discardsPartialOk =
    Array.isArray(failedResponse?.["output"]) &&
    failedResponse["output"].length === 0 &&
    failedResponse["output_text"] === "" &&
    failedResponse["status"] === "failed" &&
    usage !== undefined &&
    usage["input_tokens"] === 0 &&
    usage["output_tokens"] === 0;
  const causeOk = errorMessage.includes("incomplete chunked read") && errorCode === "server_error";
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
    hasDeltaBeforeFailedOk,
    endsWithFailedOk,
    discardsPartialOk,
    causeOk,
    noDoneOk: !hasDone,
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
  const body = JSON.stringify({ model: "m", input: "SCEN:midbreak hi", stream: true });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth("midbreak", oracle, candidate, (apiKey) => postRequestLines(apiKey, body), body)),
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
    hasDeltaBeforeFailedOk: oracleAnalysis.hasDeltaBeforeFailedOk && candidateAnalysis.hasDeltaBeforeFailedOk,
    endsWithFailedOk: oracleAnalysis.endsWithFailedOk && candidateAnalysis.endsWithFailedOk,
    discardsPartialOk: oracleAnalysis.discardsPartialOk && candidateAnalysis.discardsPartialOk,
    causeOk: oracleAnalysis.causeOk && candidateAnalysis.causeOk,
    noDoneOk: oracleAnalysis.noDoneOk && candidateAnalysis.noDoneOk,
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
        { path: "/v1/responses (stream)", rule: "`id` normalized before the bilateral diff; every `created_at` occurrence zeroed." },
        { path: "*", rule: "`date`/`server` headers dropped; content-length dropped; header order not compared." },
      ],
    },
    rawEvidence,
    match: ok,
    differences,
    expectedUpstreamRequests: 2,
  };
}
