// Assertions 43 (same Content-Type/spacing as chat SSE, but every frame
// carries an `event:` line matching `data.type`), 44 (exact frame sequence:
// created -> output_item.added -> content_part.added -> zero+ text deltas ->
// completed), 45 (sequence_number starts at 0, increases by exactly 1, ids
// and output/content indices stay coherent across frames), 46 (the
// response.created object has exactly 13 fields and no usage/output_text;
// completed has exactly 16) and 47 (Responses success never emits [DONE],
// a data-only frame, or a separate finish/usage chunk — the last frame IS
// response.completed).
import type { FakeUpstream, UpstreamRequestRecord } from "../fake-upstream.js";
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

interface AnalyzedResponsesSse {
  readonly text: string;
  readonly shapeOk: boolean;
  readonly sequenceOk: boolean;
  readonly typeSequenceOk: boolean;
  readonly fieldCountsOk: boolean;
  readonly noDoneOk: boolean;
  readonly endsWithCompleted: boolean;
}

function analyze(body: string): AnalyzedResponsesSse {
  const { frames, parseFailed, hasDone } = parseFrames(body);
  const noDoneOk = !hasDone;

  const typeSequenceOk =
    frames.length >= 4 &&
    frames[0]?.eventType === "response.created" &&
    frames[1]?.eventType === "response.output_item.added" &&
    frames[2]?.eventType === "response.content_part.added" &&
    frames.slice(3, -1).every((frame) => frame.eventType === "response.output_text.delta") &&
    frames.at(-1)?.eventType === "response.completed" &&
    frames.every((frame) => frame.eventType === frame.data["type"]);

  const sequenceNumbers = frames.map((frame) => frame.data["sequence_number"]);
  const sequenceOk =
    sequenceNumbers.every((value, index) => value === index) && sequenceNumbers.length > 0;

  const createdResponse = frames[0]?.data["response"] as Record<string, unknown> | undefined;
  const completedResponse = frames.at(-1)?.data["response"] as Record<string, unknown> | undefined;
  const fieldCountsOk =
    createdResponse !== undefined &&
    Object.keys(createdResponse).length === 13 &&
    !("usage" in createdResponse) &&
    !("output_text" in createdResponse) &&
    completedResponse !== undefined &&
    // Contract-prose erratum, not a candidate defect: assertions 31/46 both
    // say "16 campos", but the contract's own cited authority disagrees.
    // eval-t11-baseline/evidence-s03-nonstream.json probe "resp_ok" and
    // evidence-s04-stream.json probe "resp_stream_ok"'s response.completed
    // both measure 15 keys (id, object, created_at, status, model, output,
    // output_text, error, incomplete_details, instructions, metadata,
    // parallel_tool_calls, tool_choice, tools, usage) against the real
    // pinned oracle — matching what this scenario measures live, and what
    // tests/server-responses-format.test.ts already measured during
    // implementation. The contract's own rule governs: "nas divergências
    // listadas pelo baseline, prevalece a medição no fio".
    Object.keys(completedResponse).length === 15;

  const responseId = createdResponse?.["id"];
  const createdAt = createdResponse?.["created_at"];
  const completedCreatedAt = completedResponse?.["created_at"];
  const idOk = typeof responseId === "string" && RESP_ID.test(responseId);
  const createdAtOk = typeof createdAt === "number" && Number.isInteger(createdAt);
  // Assertion 33: created_at "permanece idêntico em todos os frames daquele
  // stream" — not just present-and-integer on frame 0, but the SAME value
  // on response.completed too (a candidate that re-stamped the clock at
  // completion would otherwise pass every other check here).
  const createdAtStableOk = createdAtOk && completedCreatedAt === createdAt;
  const shapeOk = !parseFailed && idOk && createdAtStableOk;

  const normalizedFrames = frames.map((frame) => {
    const cloned = JSON.parse(JSON.stringify(frame.data)) as Record<string, unknown>;
    if (typeof responseId === "string") {
      const text = JSON.stringify(cloned).replaceAll(responseId, "<ID>");
      return { eventType: frame.eventType, data: JSON.parse(text) as Record<string, unknown> };
    }
    return frame;
  });
  const text = normalizedFrames
    .map((frame) => {
      const dataWithZeroedCreated = { ...frame.data };
      const nested = dataWithZeroedCreated["response"];
      if (nested !== null && typeof nested === "object" && "created_at" in nested) {
        (nested as Record<string, unknown>)["created_at"] = 0;
      }
      return `event: ${String(frame.eventType)}\ndata: ${JSON.stringify(dataWithZeroedCreated)}`;
    })
    .join("\n\n");

  return {
    text,
    shapeOk,
    sequenceOk,
    typeSequenceOk,
    fieldCountsOk,
    noDoneOk,
    endsWithCompleted: frames.at(-1)?.eventType === "response.completed",
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
  const body = JSON.stringify({ model: "m", input: "SCEN:ok hi", stream: true });
  const before = upstream.requests.length;
  const probe: ProbeRecord & { upstream: UpstreamRequestRecord[] } = {
    ...(await probeBoth(
      "success",
      oracle,
      candidate,
      (apiKey) => postRequestLines(apiKey, body),
      body,
    )),
    upstream: upstream.requests.slice(before),
  };

  const rawEvidence = [
    {
      id: probe.id,
      request: probe.request,
      oracle: probe.oracle,
      candidate: probe.candidate,
      upstream: probe.upstream,
    },
  ];

  const oracleAnalysis = analyze(probe.oracle.body);
  const candidateAnalysis = analyze(probe.candidate.body);
  const comparison = compareRaw(probe.oracle, probe.candidate, {
    oracleBody: oracleAnalysis.text,
    candidateBody: candidateAnalysis.text,
    extraDroppedHeaders: ["content-length"],
  });
  const headersOk = [probe.oracle, probe.candidate].every((response) => {
    const contentType = response.headers.find(([name]) => name === "content-type")?.[1] ?? "";
    const transferEncoding =
      response.headers.find(([name]) => name === "transfer-encoding")?.[1] ?? "";
    return (
      contentType === "text/event-stream; charset=utf-8" &&
      transferEncoding.toLowerCase() === "chunked"
    );
  });
  const checks = {
    headersOk,
    shapeOk: oracleAnalysis.shapeOk && candidateAnalysis.shapeOk,
    sequenceOk: oracleAnalysis.sequenceOk && candidateAnalysis.sequenceOk,
    typeSequenceOk: oracleAnalysis.typeSequenceOk && candidateAnalysis.typeSequenceOk,
    fieldCountsOk: oracleAnalysis.fieldCountsOk && candidateAnalysis.fieldCountsOk,
    noDoneOk: oracleAnalysis.noDoneOk && candidateAnalysis.noDoneOk,
    endsWithCompleted: oracleAnalysis.endsWithCompleted && candidateAnalysis.endsWithCompleted,
    upstreamCountOk: probe.upstream.length === 2,
  };
  const ok = comparison.match && Object.values(checks).every(Boolean);
  const record = {
    id: probe.id,
    normalized: { oracle: comparison.oracle, candidate: comparison.candidate },
    checks,
    match: ok,
  };
  const differences = ok ? [] : [record];

  return {
    projection: {
      probes: [record],
      normalizations: [
        {
          path: "/v1/responses (stream)",
          rule: "`id` (resp_<32hex>, format-checked) and every `created_at` occurrence normalized before the bilateral body diff; `sequence_number` is compared literally (assertion 45 requires it start at 0 and increase by exactly 1, so normalizing it away would hide a real divergence).",
        },
        {
          path: "*",
          rule: "`date`/`server` headers dropped; content-length dropped (SSE responses never carry one); header order not compared.",
        },
      ],
    },
    rawEvidence,
    match: ok,
    differences,
    expectedUpstreamRequests: 2,
  };
}
