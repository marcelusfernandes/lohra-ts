// Assertion 40: an upstream failure discovered AFTER the SSE stream to the
// client is already open keeps the role chunk already sent, emits a frame
// {"error":{"message":...,"type":"upstream_error"}} whose message contains
// the upstream status 418 and the T11_CAUSE_<nonce> canary from assertion
// 29, omits the finish/usage chunks, and still terminates in [DONE].
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

interface Analysis {
  readonly text: string;
  readonly shapeOk: boolean;
  readonly startsWithRoleDelta: boolean;
  readonly hasErrorFrame: boolean;
  readonly errorCauseOk: boolean;
  readonly hasFinishOrUsage: boolean;
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
  const ids = parsedFrames
    .map((frame) => (frame["choices"] === undefined ? undefined : frame["id"]))
    .filter((id) => id !== undefined);
  const idsOk = ids.every((id) => typeof id === "string" && CHATCMPL_ID.test(id));
  const startsWithRoleDelta =
    parsedFrames.length > 0 &&
    (parsedFrames[0]?.["choices"] as Array<{ delta?: { role?: string } }> | undefined)?.[0]?.delta
      ?.role === "assistant";
  const errorFrame = parsedFrames.find((frame) => "error" in frame);
  const hasErrorFrame = errorFrame !== undefined;
  const errorMessageRaw = (errorFrame?.["error"] as Record<string, unknown> | undefined)?.[
    "message"
  ];
  const errorMessage = typeof errorMessageRaw === "string" ? errorMessageRaw : "";
  const errorType = (errorFrame?.["error"] as Record<string, unknown> | undefined)?.["type"];
  const errorCauseOk =
    errorMessage.includes("418") &&
    errorMessage.includes(CAUSE_CANARY) &&
    errorType === "upstream_error";
  const hasFinishOrUsage = parsedFrames.some(
    (frame) =>
      "usage" in frame ||
      (frame["choices"] as Array<{ finish_reason?: unknown }> | undefined)?.some(
        (choice) => choice.finish_reason !== null && choice.finish_reason !== undefined,
      ),
  );
  const endsWithDone = dataLines.at(-1) === "[DONE]";
  for (const frame of parsedFrames) {
    if ("id" in frame) frame["id"] = "<ID>";
    if ("created" in frame) frame["created"] = 0;
  }
  const normalizedText = [
    ...parsedFrames.map((frame) => `data: ${JSON.stringify(frame)}`),
    ...(dataLines.includes("[DONE]") ? ["data: [DONE]"] : []),
  ].join("\n\n");
  return {
    text: normalizedText,
    shapeOk: !parseFailed && idsOk,
    startsWithRoleDelta,
    hasErrorFrame,
    errorCauseOk,
    hasFinishOrUsage,
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
    messages: [{ role: "user", content: "SCEN:err418 hi" }],
    stream: true,
  });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth(
      "post-open-error",
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
    roleDeltaKeptOk: oracleAnalysis.startsWithRoleDelta && candidateAnalysis.startsWithRoleDelta,
    errorFrameOk: oracleAnalysis.hasErrorFrame && candidateAnalysis.hasErrorFrame,
    errorCauseOk: oracleAnalysis.errorCauseOk && candidateAnalysis.errorCauseOk,
    noFinishOrUsageOk: !oracleAnalysis.hasFinishOrUsage && !candidateAnalysis.hasFinishOrUsage,
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
          rule: "every frame's `id`/`created` normalized before the bilateral diff; the error frame's message is checked for 418+canary content, then included as-is in the text comparison (its exact repr is not further excused here).",
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
