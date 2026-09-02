// Assertion 50: a protocol-clean chunked EOF from upstream after deltas
// follows the success path equivalent to chat's assertion 41 —
// response.completed, output_text carrying the partial text, an ESTIMATED
// usage, and no [DONE] or protocol error frame.
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
      frames.push({
        eventType: eventLine?.slice("event: ".length),
        data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>,
      });
    } catch {
      parseFailed = true;
    }
  }
  return { frames, parseFailed, hasDone };
}

interface Analysis {
  readonly text: string;
  readonly shapeOk: boolean;
  readonly endsWithCompletedOk: boolean;
  readonly noProtocolErrorOk: boolean;
  readonly contentPreservedOk: boolean;
  readonly usageEstimatedPresentOk: boolean;
  readonly noDoneOk: boolean;
}

function analyze(body: string): Analysis {
  const { frames, parseFailed, hasDone } = parseFrames(body);
  const endsWithCompletedOk = frames.at(-1)?.eventType === "response.completed";
  const noProtocolErrorOk = frames.every((frame) => frame.eventType !== "response.failed");
  const completedResponse = frames.at(-1)?.data["response"] as Record<string, unknown> | undefined;
  const outputText = completedResponse?.["output_text"];
  const contentPreservedOk =
    typeof outputText === "string" && outputText.includes("FAKE-UPSTREAM-STREAM:cleaneof");
  const usage = completedResponse?.["usage"] as Record<string, unknown> | undefined;
  const usageEstimatedPresentOk =
    usage !== undefined &&
    typeof usage["input_tokens"] === "number" &&
    typeof usage["output_tokens"] === "number";
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
      if (nested !== null && typeof nested === "object" && "created_at" in nested)
        (nested as Record<string, unknown>)["created_at"] = 0;
      // Estimation math is only required to agree in SHAPE at this
      // scenario's scope (assertion 62's own vectors govern the exact
      // arithmetic) — replace the usage object so a same-side numeric
      // rounding wobble across runs doesn't false-fail the bilateral diff.
      if (nested !== null && typeof nested === "object" && "usage" in nested)
        (nested as Record<string, unknown>)["usage"] = "<USAGE>";
      return `event: ${String(frame.eventType)}\ndata: ${JSON.stringify(withZeroedCreated)}`;
    })
    .join("\n\n");
  return {
    text,
    shapeOk: !parseFailed && typeof idValue === "string",
    endsWithCompletedOk,
    noProtocolErrorOk,
    contentPreservedOk,
    usageEstimatedPresentOk,
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
  const body = JSON.stringify({ model: "m", input: "SCEN:cleaneof hi", stream: true });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth(
      "clean-eof",
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

  const oracleAnalysis = analyze(probe.oracle.body);
  const candidateAnalysis = analyze(probe.candidate.body);
  const comparison = compareRaw(probe.oracle, probe.candidate, {
    oracleBody: oracleAnalysis.text,
    candidateBody: candidateAnalysis.text,
    extraDroppedHeaders: ["content-length"],
  });

  const checks = {
    statusOk:
      probe.oracle.statusLine.includes(" 200 ") && probe.candidate.statusLine.includes(" 200 "),
    shapeOk: oracleAnalysis.shapeOk && candidateAnalysis.shapeOk,
    endsWithCompletedOk:
      oracleAnalysis.endsWithCompletedOk && candidateAnalysis.endsWithCompletedOk,
    noProtocolErrorOk: oracleAnalysis.noProtocolErrorOk && candidateAnalysis.noProtocolErrorOk,
    contentPreservedOk: oracleAnalysis.contentPreservedOk && candidateAnalysis.contentPreservedOk,
    usageEstimatedPresentOk:
      oracleAnalysis.usageEstimatedPresentOk && candidateAnalysis.usageEstimatedPresentOk,
    noDoneOk: oracleAnalysis.noDoneOk && candidateAnalysis.noDoneOk,
    upstreamCountOk: probe.upstream.length === 2,
    bilateralOk: comparison.match,
  };
  const ok = Object.values(checks).every(Boolean);
  const record = {
    id: probe.id,
    checks,
    normalized: { oracle: comparison.oracle, candidate: comparison.candidate },
    match: ok,
  };
  const differences = ok ? [] : [record];

  return {
    projection: {
      probes: [record],
      normalizations: [
        {
          path: "/v1/responses (stream)",
          rule: "`id` normalized before the bilateral diff; every `created_at` occurrence zeroed; `usage` replaced with a placeholder (estimate arithmetic is governed by assertion 62's own vectors, not this scenario).",
        },
        {
          path: "*",
          rule: "`date`/`server` headers dropped; content-length dropped; header order not compared.",
        },
      ],
    },
    rawEvidence,
    match: ok,
    differences,
    expectedUpstreamRequests: 2,
  };
}
