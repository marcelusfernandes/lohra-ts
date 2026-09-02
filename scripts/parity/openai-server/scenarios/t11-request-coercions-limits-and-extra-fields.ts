// Assertions 25 (chat accepts model:"" and content:null, echoing empty
// model and sending "" to the runtime; extra top_p/n/tools/tool_choice are
// ignored without error), 27 (stream:"true" coerces to true;
// stream_options.include_usage:"yes" is truthy and enables the usage frame
// on chat; Responses doesn't declare stream_options — the field is ignored,
// never reaches the runtime, never creates a separate usage frame) and 29a's
// default-limit half (absent max_tokens uses the profile default 8192;
// absent temperature omits the key entirely, never sends null).
import type { FakeUpstream, UpstreamRequestRecord } from "../fake-upstream.js";
import { compareRaw, probeBoth, type ServerHandle } from "../harness.js";

function postRequestLines(path: string, apiKey: string | null, body: string): string {
  return (
    `POST ${path} HTTP/1.1\n` +
    "Host: 127.0.0.1\n" +
    "Content-Type: application/json\n" +
    `Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\n` +
    `Authorization: Bearer ${apiKey ?? ""}\n` +
    "Connection: close\n"
  );
}

// SSE frames use the spaced python-json.dumps style (`"id": "..."`), while
// non-stream bodies are compact (`"id":"..."`) — the regex tolerates either.
function normalizeIds(body: string): string {
  return body
    .replaceAll(/"id":\s*"(chatcmpl-|msg_resp_|resp_)[0-9a-f]{32}"/gu, '"id":"<ID>"')
    .replaceAll(/"created":\s*\d+/gu, '"created":0')
    .replaceAll(/"created_at":\s*\d+/gu, '"created_at":0');
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
  const checks: Record<string, boolean> = {};
  const rawEntries: Record<string, unknown> = {};

  // 1. empty model + null content + ignored extra fields, chat non-stream.
  const emptyModelBody = JSON.stringify({
    model: "",
    messages: [{ role: "user", content: null }],
    top_p: 0.9,
    n: 3,
    tools: [{ type: "function", function: { name: "evil", parameters: {} } }],
    tool_choice: "auto",
  });
  const before1 = upstream.requests.length;
  const probe1 = await probeBoth(
    "empty-model-null-content",
    oracle,
    candidate,
    (apiKey) => postRequestLines("/v1/chat/completions", apiKey, emptyModelBody),
    emptyModelBody,
  );
  const upstream1 = upstream.requests.slice(before1);
  rawEntries["empty-model-null-content"] = {
    request: probe1.request,
    oracle: probe1.oracle,
    candidate: probe1.candidate,
    upstream: upstream1,
  };
  const comparison1 = compareRaw(probe1.oracle, probe1.candidate, {
    oracleBody: normalizeIds(probe1.oracle.body),
    candidateBody: normalizeIds(probe1.candidate.body),
  });
  checks["emptyModelEchoedOk"] =
    probe1.oracle.body.includes('"model":""') && probe1.candidate.body.includes('"model":""');
  checks["emptyModelBilateralOk"] = comparison1.match;
  checks["nullContentSentAsEmptyStringOk"] = upstream1.every((record) => {
    const messages = record.body["messages"];
    const last = Array.isArray(messages)
      ? (messages.at(-1) as Record<string, unknown> | undefined)
      : undefined;
    return last?.["content"] === "";
  });
  checks["extraFieldsNotForwardedOk"] = upstream1.every(
    (record) =>
      !("top_p" in record.body) &&
      !("n" in record.body) &&
      !("tools" in record.body) &&
      !("tool_choice" in record.body),
  );

  // 2. stream:"true" (string) coerces to true — a real SSE response.
  const stringStreamBody = JSON.stringify({
    model: "m",
    messages: [{ role: "user", content: "SCEN:ok hi" }],
    stream: "true",
  });
  const probe2 = await probeBoth(
    "stream-string-true",
    oracle,
    candidate,
    (apiKey) => postRequestLines("/v1/chat/completions", apiKey, stringStreamBody),
    stringStreamBody,
  );
  rawEntries["stream-string-true"] = {
    request: probe2.request,
    oracle: probe2.oracle,
    candidate: probe2.candidate,
  };
  checks["stringStreamCoercedOk"] =
    probe2.oracle.headers.some(
      ([name, value]) => name === "content-type" && value.startsWith("text/event-stream"),
    ) &&
    probe2.candidate.headers.some(
      ([name, value]) => name === "content-type" && value.startsWith("text/event-stream"),
    );

  // 3. stream_options.include_usage:"yes" (truthy string) enables the usage
  // chunk on chat SSE.
  const usageYesBody = JSON.stringify({
    model: "m",
    messages: [{ role: "user", content: "SCEN:ok hi" }],
    stream: true,
    stream_options: { include_usage: "yes" },
  });
  const probe3 = await probeBoth(
    "chat-stream-options-yes",
    oracle,
    candidate,
    (apiKey) => postRequestLines("/v1/chat/completions", apiKey, usageYesBody),
    usageYesBody,
  );
  rawEntries["chat-stream-options-yes"] = {
    request: probe3.request,
    oracle: probe3.oracle,
    candidate: probe3.candidate,
  };
  checks["stringTruthyUsageEnabledOk"] =
    probe3.oracle.body.includes('"usage":') && probe3.candidate.body.includes('"usage":');
  const comparison3 = compareRaw(probe3.oracle, probe3.candidate, {
    oracleBody: normalizeIds(probe3.oracle.body),
    candidateBody: normalizeIds(probe3.candidate.body),
    extraDroppedHeaders: ["content-length"],
  });
  checks["chatStreamOptionsBilateralOk"] = comparison3.match;

  // 4. Responses' PUBLIC schema doesn't declare stream_options (unlike
  // chat): a client-supplied one on /v1/responses is silently ignored by
  // the request parser (validateResponsesBody has no such field) and never
  // creates a separate usage-only chunk on the CLIENT-facing SSE stream —
  // Responses always bundles usage into response.completed. (The provider
  // transport's own internal upstream call may request usage tracking for
  // its own accounting regardless of this client field; that upstream-side
  // wire detail is not what this assertion governs.)
  const responsesExtraFieldBody = JSON.stringify({
    model: "m",
    input: "SCEN:ok hi",
    stream: true,
    stream_options: { include_usage: true },
  });
  const before4 = upstream.requests.length;
  const probe4 = await probeBoth(
    "responses-stream-options-ignored",
    oracle,
    candidate,
    (apiKey) => postRequestLines("/v1/responses", apiKey, responsesExtraFieldBody),
    responsesExtraFieldBody,
  );
  const upstream4 = upstream.requests.slice(before4);
  rawEntries["responses-stream-options-ignored"] = {
    request: probe4.request,
    oracle: probe4.oracle,
    candidate: probe4.candidate,
    upstream: upstream4,
  };
  const oracleFrameCount = (probe4.oracle.body.match(/\ndata: /gu) ?? []).length;
  const candidateFrameCount = (probe4.candidate.body.match(/\ndata: /gu) ?? []).length;
  // Exactly created, output_item.added, content_part.added, >=0 deltas,
  // completed — no extra usage-only frame. The precise count is compared
  // bilaterally (both real processes must agree), not hardcoded here.
  checks["responsesFrameCountBilateralOk"] =
    oracleFrameCount === candidateFrameCount && oracleFrameCount >= 4;
  const noSeparateUsageFrame = (body: string): boolean =>
    !/"type":\s*"response\.[a-z_]*usage/u.test(body);
  checks["responsesNoSeparateUsageFrameOk"] =
    noSeparateUsageFrame(probe4.oracle.body) && noSeparateUsageFrame(probe4.candidate.body);
  checks["responsesEndsWithCompletedOk"] =
    /"type":\s*"response\.completed"/u.test(probe4.oracle.body) &&
    /"type":\s*"response\.completed"/u.test(probe4.candidate.body);

  // 5. Default limit (no max_tokens) uses the profile default 8192; absent
  // temperature omits the key entirely (never sends null).
  const defaultsBody = JSON.stringify({
    model: "m",
    messages: [{ role: "user", content: "SCEN:ok hi" }],
  });
  const before5 = upstream.requests.length;
  const probe5 = await probeBoth(
    "defaults-max-tokens-temperature",
    oracle,
    candidate,
    (apiKey) => postRequestLines("/v1/chat/completions", apiKey, defaultsBody),
    defaultsBody,
  );
  const upstream5 = upstream.requests.slice(before5);
  rawEntries["defaults-max-tokens-temperature"] = {
    request: probe5.request,
    oracle: probe5.oracle,
    candidate: probe5.candidate,
    upstream: upstream5,
  };
  checks["defaultMaxTokensOk"] = upstream5.every(
    (record: UpstreamRequestRecord) => record.body["max_tokens"] === 8192,
  );
  checks["temperatureOmittedNotNullOk"] = upstream5.every(
    (record: UpstreamRequestRecord) => !("temperature" in record.body),
  );

  const differences = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([id, ok]) => ({ id, ok }));
  const match = differences.length === 0;

  return {
    projection: { checks },
    rawEvidence: rawEntries,
    match,
    differences,
    expectedUpstreamRequests: 10,
  };
}
