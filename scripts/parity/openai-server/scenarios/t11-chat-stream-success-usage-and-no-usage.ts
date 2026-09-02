// Assertions 35 (SSE headers: exact Content-Type, chunked, no
// content-length, no invented Cache-Control/X-Accel-Buffering/CORS), 36
// (Python-default-spaced frame JSON), 37 (role delta -> content deltas ->
// empty finish delta), 38 (usage chunk toggles on stream_options.
// include_usage), 39 ([DONE] terminates every success, nothing after) and
// 42 (no delta.tool_calls / finish_reason:"tool_calls" ever reaches the
// client in relay mode).
import type { FakeUpstream, UpstreamRequestRecord } from "../fake-upstream.js";
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

const CHATCMPL_ID = /^chatcmpl-[0-9a-f]{32}$/u;
const FORBIDDEN_HEADERS = ["cache-control", "x-accel-buffering", "access-control-allow-origin"];

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

interface FrameCheck {
  readonly text: string;
  readonly shapeOk: boolean;
  readonly startsWithRoleDelta: boolean;
  readonly endsWithDone: boolean;
  readonly hasUsageChunk: boolean;
  readonly leaksToolCalls: boolean;
}

/** Splits the dechunked SSE body into `data: {...}` frames (dechunk() in
 * harness.ts already strips the HTTP chunk-transfer framing — this only
 * deals with SSE's own `\n\n` frame delimiter), format-checks every
 * `id`/`created` as assertion 33 requires (32-hex `chatcmpl-` id, integer
 * created, SAME value on every frame of the stream), then zeroes both for
 * the bilateral text comparison. */
function analyzeSse(body: string): FrameCheck {
  const frames = body.split("\n\n").filter((frame) => frame.trim().length > 0);
  const dataLines = frames.map((frame) => frame.replace(/^data: /u, ""));
  const jsonFrames = dataLines.filter((line) => line !== "[DONE]");
  const parsedFrames: Array<Record<string, unknown>> = [];
  let parseFailed = false;
  for (const line of jsonFrames) {
    try {
      parsedFrames.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      parseFailed = true;
    }
  }
  const ids = parsedFrames.map((frame) => frame["id"]);
  const createds = parsedFrames.map((frame) => frame["created"]);
  const idsOk =
    ids.every((id) => typeof id === "string" && CHATCMPL_ID.test(id)) && new Set(ids).size <= 1;
  const createdsOk =
    createds.every((value) => typeof value === "number" && Number.isInteger(value)) &&
    new Set(createds).size <= 1;
  const startsWithRoleDelta =
    parsedFrames.length > 0 &&
    (parsedFrames[0]?.["choices"] as Array<{ delta?: { role?: string } }> | undefined)?.[0]?.delta
      ?.role === "assistant";
  const endsWithDone = dataLines.at(-1) === "[DONE]";
  const hasUsageChunk = parsedFrames.some((frame) => frame["usage"] !== undefined);
  const leaksToolCalls = jsonFrames.some((line) => line.includes("tool_calls"));
  for (const frame of parsedFrames) {
    frame["id"] = "<ID>";
    frame["created"] = 0;
  }
  const normalizedLines = [
    ...parsedFrames.map((frame) => `data: ${JSON.stringify(frame)}`),
    ...(dataLines.includes("[DONE]") ? ["data: [DONE]"] : []),
  ];
  return {
    text: normalizedLines.join("\n\n"),
    shapeOk: !parseFailed && idsOk && createdsOk,
    startsWithRoleDelta,
    endsWithDone,
    hasUsageChunk,
    leaksToolCalls,
  };
}

interface CaseSpec {
  readonly id: string;
  readonly includeUsage: boolean | null;
  readonly body: string;
}

function buildBody(includeUsage: boolean | null): string {
  return JSON.stringify({
    model: "m",
    messages: [{ role: "user", content: "SCEN:ok hi" }],
    stream: true,
    ...(includeUsage === null ? {} : { stream_options: { include_usage: includeUsage } }),
  });
}

const CASES: readonly CaseSpec[] = [
  { id: "with-usage", includeUsage: true, body: buildBody(true) },
  { id: "without-usage-absent", includeUsage: null, body: buildBody(null) },
  { id: "without-usage-false", includeUsage: false, body: buildBody(false) },
];

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
  const probes: (ProbeRecord & { upstream: UpstreamRequestRecord[] })[] = [];
  for (const testCase of CASES) {
    const before = upstream.requests.length;
    const probe = await probeBoth(
      testCase.id,
      oracle,
      candidate,
      (apiKey) => postRequestLines(apiKey, testCase.body),
      testCase.body,
    );
    probes.push({ ...probe, upstream: upstream.requests.slice(before) });
  }

  const rawEvidence = probes.map((entry) => ({
    id: entry.id,
    request: entry.request,
    oracle: entry.oracle,
    candidate: entry.candidate,
    upstream: entry.upstream,
  }));

  const expectUsageById = new Map(
    CASES.map((testCase) => [testCase.id, testCase.includeUsage === true]),
  );

  const differences: unknown[] = [];
  const projectedProbes = probes.map((entry) => {
    const oracleFrames = analyzeSse(entry.oracle.body);
    const candidateFrames = analyzeSse(entry.candidate.body);
    const comparison = compareRaw(entry.oracle, entry.candidate, {
      oracleBody: oracleFrames.text,
      candidateBody: candidateFrames.text,
      extraDroppedHeaders: ["content-length"],
    });
    const headersOk = [entry.oracle, entry.candidate].every((response) => {
      const contentType = response.headers.find(([name]) => name === "content-type")?.[1] ?? "";
      const transferEncoding =
        response.headers.find(([name]) => name === "transfer-encoding")?.[1] ?? "";
      const hasContentLength = response.headers.some(([name]) => name === "content-length");
      const hasForbidden = response.headers.some(([name]) => FORBIDDEN_HEADERS.includes(name));
      return (
        contentType === "text/event-stream; charset=utf-8" &&
        transferEncoding.toLowerCase() === "chunked" &&
        !hasContentLength &&
        !hasForbidden
      );
    });
    const shapeOk = oracleFrames.shapeOk && candidateFrames.shapeOk;
    const roleDeltaOk = oracleFrames.startsWithRoleDelta && candidateFrames.startsWithRoleDelta;
    const doneOk = oracleFrames.endsWithDone && candidateFrames.endsWithDone;
    const expectedUsage = expectUsageById.get(entry.id) ?? false;
    const usageOk =
      oracleFrames.hasUsageChunk === expectedUsage &&
      candidateFrames.hasUsageChunk === expectedUsage;
    const noToolLeakOk = !oracleFrames.leaksToolCalls && !candidateFrames.leaksToolCalls;
    const upstreamCountOk = entry.upstream.length === 2;
    const ok =
      comparison.match &&
      headersOk &&
      shapeOk &&
      roleDeltaOk &&
      doneOk &&
      usageOk &&
      noToolLeakOk &&
      upstreamCountOk;
    const record = {
      id: entry.id,
      normalized: { oracle: comparison.oracle, candidate: comparison.candidate },
      checks: { headersOk, shapeOk, roleDeltaOk, doneOk, usageOk, noToolLeakOk, upstreamCountOk },
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
          path: "/v1/chat/completions (stream)",
          rule: "every SSE frame's `id` checked against chatcmpl-<32hex> and SAME across frames, then set to <ID>; `created` checked integer and SAME across frames, then zeroed (assertions 30/33).",
        },
        {
          path: "*",
          rule: "`date`/`server` headers dropped; content-length dropped (SSE responses never carry one); header order not compared.",
        },
      ],
    },
    rawEvidence,
    match,
    differences,
    expectedUpstreamRequests: 6,
  };
}
