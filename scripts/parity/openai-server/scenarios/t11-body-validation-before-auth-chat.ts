// Assertions 20 (parse/schema precedes auth on POSTs), 21 (the closed 422
// body-exact table, zero upstream calls) and half of 22 (the two chat-side
// 400 CompletionError cases: `messages:[]` and last-message-role-not-user).
// No bilateral literal is hardcoded here — the harness never assumes what
// "correct" looks like, it proves the two real processes emit the identical
// wire bytes, which is what actually falsifies a divergence.
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

interface CaseSpec {
  readonly id: string;
  readonly contentType: string;
  readonly body: string;
  readonly withAuth: boolean;
  readonly expectedStatus: 401 | 422 | 400;
}

const CASES: readonly CaseSpec[] = [
  // Assertion 20: body validation precedes auth — invalid body 422s even
  // with no Authorization at all; a structurally valid body instead 401s.
  { id: "model-ausente-no-auth", contentType: "application/json", body: '{"messages": [{"role": "user", "content": "x"}]}', withAuth: false, expectedStatus: 422 },
  { id: "valid-body-no-auth", contentType: "application/json", body: '{"model": "m", "messages": [{"role": "user", "content": "x"}]}', withAuth: false, expectedStatus: 401 },
  // Assertion 21's closed 422 table (chat side), all zero-upstream.
  { id: "body-vazio", contentType: "application/json", body: "", withAuth: false, expectedStatus: 422 },
  { id: "content-type-text-plain", contentType: "text/plain", body: '{"model": "fake-model-a", "messages": [{"role": "user", "content": "SCEN:ok hi"}]}', withAuth: false, expectedStatus: 422 },
  { id: "messages-nao-lista", contentType: "application/json", body: '{"model": "m", "messages": "x"}', withAuth: false, expectedStatus: 422 },
  { id: "item-messages-nao-dict", contentType: "application/json", body: '{"model": "m", "messages": ["x"]}', withAuth: false, expectedStatus: 422 },
  { id: "temperature-hot", contentType: "application/json", body: '{"model": "m", "messages": [{"role": "user", "content": "x"}], "temperature": "hot"}', withAuth: false, expectedStatus: 422 },
  { id: "stream-null", contentType: "application/json", body: '{"model": "m", "messages": [{"role": "user", "content": "x"}], "stream": null}', withAuth: false, expectedStatus: 422 },
  { id: "json-malformed", contentType: "application/json", body: "{nope", withAuth: false, expectedStatus: 422 },
  // Assertion 22 (chat half): valid auth, body structurally parses, but the
  // CONTENT is invalid — 400 CompletionError before any SSE byte or upstream
  // call.
  { id: "messages-vazio-com-auth", contentType: "application/json", body: '{"model": "m", "messages": []}', withAuth: true, expectedStatus: 400 },
  { id: "ultima-role-nao-user-com-auth", contentType: "application/json", body: '{"model": "m", "messages": [{"role": "assistant", "content": "x"}]}', withAuth: true, expectedStatus: 400 },
];

function postRequestLines(path: string, contentType: string, body: string, authLine: string): string {
  const length = Buffer.byteLength(body, "utf8");
  return (
    `POST ${path} HTTP/1.1\n` +
    "Host: 127.0.0.1\n" +
    `Content-Type: ${contentType}\n` +
    `Content-Length: ${String(length)}\n` +
    authLine +
    "Connection: close\n"
  );
}

/** The JSON-malformed case (assertion 21) excuses exactly two fields: the
 * CPython parser's numeric byte offset (`loc[1]`) and its exact message
 * text (`ctx.error`) — everything else in the 422 body must match. */
function normalizeJsonInvalid(body: string): { text: string; shapeOk: boolean } {
  let parsed: { detail?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { text: body, shapeOk: false };
  }
  const detail = parsed.detail?.[0];
  const shapeOk =
    detail?.["type"] === "json_invalid" &&
    Array.isArray(detail["loc"]) &&
    detail["loc"][0] === "body" &&
    typeof detail["loc"][1] === "number" &&
    detail["msg"] === "JSON decode error" &&
    JSON.stringify(detail["input"]) === "{}" &&
    typeof (detail["ctx"] as Record<string, unknown> | undefined)?.["error"] === "string";
  if (shapeOk) {
    (detail["loc"] as unknown[])[1] = 0;
    (detail["ctx"] as Record<string, unknown>)["error"] = "<EXCUSED>";
  }
  return { text: JSON.stringify(parsed), shapeOk };
}

export async function run(
  oracle: ServerHandle,
  candidate: ServerHandle,
): Promise<{
  projection: unknown;
  rawEvidence: unknown;
  match: boolean;
  differences: unknown[];
  expectedUpstreamRequests: number;
}> {
  const probes: ProbeRecord[] = [];
  for (const testCase of CASES) {
    probes.push(
      await probeBoth(
        testCase.id,
        oracle,
        candidate,
        (apiKey) =>
          postRequestLines(
            "/v1/chat/completions",
            testCase.contentType,
            testCase.body,
            testCase.withAuth ? `Authorization: Bearer ${apiKey ?? ""}\n` : "",
          ),
        testCase.body,
      ),
    );
  }

  const rawEvidence = probes.map((entry) => ({ id: entry.id, request: entry.request, oracle: entry.oracle, candidate: entry.candidate }));
  const expectedStatusById = new Map(CASES.map((testCase) => [testCase.id, testCase.expectedStatus]));

  const differences: unknown[] = [];
  const projectedProbes = probes.map((entry) => {
    const isMalformed = entry.id === "json-malformed";
    const oracleNorm = isMalformed ? normalizeJsonInvalid(entry.oracle.body) : { text: entry.oracle.body, shapeOk: true };
    const candidateNorm = isMalformed ? normalizeJsonInvalid(entry.candidate.body) : { text: entry.candidate.body, shapeOk: true };
    const comparison = compareRaw(entry.oracle, entry.candidate, {
      oracleBody: oracleNorm.text,
      candidateBody: candidateNorm.text,
      // The excused ctx.error text has a different byte length on each
      // side, so content-length (tied to the true wire body, not our
      // normalized comparison text) is meaningless to compare here.
      extraDroppedHeaders: isMalformed ? ["content-length"] : [],
    });
    const shapeOk = oracleNorm.shapeOk && candidateNorm.shapeOk;
    const expectedStatus = ` ${String(expectedStatusById.get(entry.id))} `;
    const statusOk = entry.oracle.statusLine.includes(expectedStatus) && entry.candidate.statusLine.includes(expectedStatus);
    const ok = comparison.match && shapeOk && statusOk;
    const record = { id: entry.id, expectedStatus: expectedStatus.trim(), normalized: { oracle: comparison.oracle, candidate: comparison.candidate }, match: ok };
    if (!ok) differences.push(record);
    return record;
  });

  const match = differences.length === 0;
  return {
    projection: {
      probes: projectedProbes,
      normalizations: [
        {
          path: "/v1/chat/completions (json-malformed only)",
          rule: "detail[0].loc[1] (CPython byte offset) and detail[0].ctx.error (CPython parser message) excused per assertion 21's table; shape (type/loc[0]/msg/input/ctx.error-is-string) verified before excusing. content-length also dropped from comparison since it reflects the true (differing) excused-message byte count.",
        },
        { path: "*", rule: "`date`/`server` headers dropped; header order not compared (assertion 9 pins body key order, not header order)." },
      ],
    },
    rawEvidence,
    match,
    differences,
    expectedUpstreamRequests: 0,
  };
}
