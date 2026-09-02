// Assertion 41: a protocol-clean chunked EOF from upstream after deltas
// (no finish chunk, no [DONE] from the FAKE UPSTREAM itself) is NOT an
// error on the client-facing stream — the candidate/oracle server keeps
// the partial text, emits a normal finish:"stop", an ESTIMATED usage chunk
// (stream_options.include_usage requested) and [DONE]. Marked a candidate
// debt in the contract, but PASS for T11 parity.
import type { FakeUpstream, UpstreamRequestRecord } from "../fake-upstream.js";
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

interface Analysis {
  readonly text: string;
  readonly shapeOk: boolean;
  readonly hasErrorFrame: boolean;
  readonly finishStopOk: boolean;
  readonly hasUsageChunk: boolean;
  readonly contentPreservedOk: boolean;
  readonly endsWithDone: boolean;
}

function analyze(body: string): Analysis {
  const frames = body.split("\n\n").filter((frame) => frame.trim().length > 0);
  const dataLines = frames.map((frame) => frame.replace(/^data: /u, ""));
  const jsonLines = dataLines.filter((line) => line !== "[DONE]");
  const parsedFrames: Array<Record<string, unknown>> = [];
  let parseFailed = false;
  for (const line of jsonLines) {
    try {
      parsedFrames.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      parseFailed = true;
    }
  }
  const ids = parsedFrames.map((frame) => frame["id"]).filter((id) => id !== undefined);
  const idsOk =
    ids.every((id) => typeof id === "string" && CHATCMPL_ID.test(id)) && new Set(ids).size <= 1;
  const hasErrorFrame = parsedFrames.some((frame) => "error" in frame);
  const finishStopOk = parsedFrames.some((frame) =>
    (frame["choices"] as Array<{ finish_reason?: unknown }> | undefined)?.some(
      (choice) => choice.finish_reason === "stop",
    ),
  );
  const hasUsageChunk = parsedFrames.some((frame) => frame["usage"] !== undefined);
  const contentPreservedOk = parsedFrames.some((frame) =>
    (frame["choices"] as Array<{ delta?: { content?: unknown } }> | undefined)?.some(
      (choice) =>
        typeof choice.delta?.content === "string" &&
        choice.delta.content.includes("FAKE-UPSTREAM-STREAM:cleaneof"),
    ),
  );
  const endsWithDone = dataLines.at(-1) === "[DONE]";
  for (const frame of parsedFrames) {
    if ("id" in frame) frame["id"] = "<ID>";
    if ("created" in frame) frame["created"] = 0;
    if (frame["usage"] !== undefined) frame["usage"] = "<USAGE>";
  }
  const normalizedText = [
    ...parsedFrames.map((frame) => `data: ${JSON.stringify(frame)}`),
    ...(dataLines.includes("[DONE]") ? ["data: [DONE]"] : []),
  ].join("\n\n");
  return {
    text: normalizedText,
    shapeOk: !parseFailed && idsOk,
    hasErrorFrame,
    finishStopOk,
    hasUsageChunk,
    contentPreservedOk,
    endsWithDone,
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
  const body = JSON.stringify({
    model: "m",
    messages: [{ role: "user", content: "SCEN:cleaneof hi" }],
    stream: true,
    stream_options: { include_usage: true },
  });
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
    noErrorFrameOk: !oracleAnalysis.hasErrorFrame && !candidateAnalysis.hasErrorFrame,
    finishStopOk: oracleAnalysis.finishStopOk && candidateAnalysis.finishStopOk,
    usageChunkOk: oracleAnalysis.hasUsageChunk && candidateAnalysis.hasUsageChunk,
    contentPreservedOk: oracleAnalysis.contentPreservedOk && candidateAnalysis.contentPreservedOk,
    doneOk: oracleAnalysis.endsWithDone && candidateAnalysis.endsWithDone,
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
          path: "/v1/chat/completions (stream)",
          rule: "`id`/`created` normalized before the bilateral diff; `usage` (the estimate) replaced with a placeholder since the two real processes' estimation math is only required to agree in SHAPE (finish:stop, a usage chunk present) at this scenario's scope — exact estimate arithmetic is covered by assertion 62's dedicated vectors.",
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
