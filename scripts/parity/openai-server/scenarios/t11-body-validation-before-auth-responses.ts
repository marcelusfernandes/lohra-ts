// Assertions 20 (parse/schema precedes auth on POSTs, Responses half: model
// absent echoes input:"x"), 21 (the closed 422 body-exact table, Responses'
// dedicated `input` numérico / `input:["x"]` row — two entries in order,
// only the Pydantic type-name token in loc[2] excused) and the Responses
// half of 22 (input:"", input:[], item without role -> 400 before any SSE
// byte or upstream call). No bilateral literal is hardcoded — the harness
// proves the two real processes emit identical wire bytes.
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

interface CaseSpec {
  readonly id: string;
  readonly contentType: string;
  readonly body: string;
  readonly withAuth: boolean;
  readonly expectedStatus: 401 | 422 | 400;
  /** Assertion 21's Responses row: loc[2] (the Pydantic type-name token,
   * e.g. "str" / "list[dict[any,any]]") is excused; everything else in the
   * two-entry detail array must match byte-exact. */
  readonly excuseTypeToken?: boolean;
}

const CASES: readonly CaseSpec[] = [
  { id: "model-ausente-no-auth", contentType: "application/json", body: '{"input": "x"}', withAuth: false, expectedStatus: 422 },
  { id: "valid-body-no-auth", contentType: "application/json", body: '{"model": "m", "input": "x"}', withAuth: false, expectedStatus: 401 },
  { id: "body-vazio", contentType: "application/json", body: "", withAuth: false, expectedStatus: 422 },
  { id: "content-type-text-plain", contentType: "text/plain", body: '{"model": "fake-model-a", "input": "SCEN:ok hi"}', withAuth: false, expectedStatus: 422 },
  { id: "temperature-hot", contentType: "application/json", body: '{"model": "m", "input": "x", "temperature": "hot"}', withAuth: false, expectedStatus: 422 },
  { id: "stream-null", contentType: "application/json", body: '{"model": "m", "input": "x", "stream": null}', withAuth: false, expectedStatus: 422 },
  { id: "json-malformed", contentType: "application/json", body: "{nope", withAuth: false, expectedStatus: 422 },
  { id: "input-numerico", contentType: "application/json", body: '{"model": "m", "input": 5}', withAuth: false, expectedStatus: 422, excuseTypeToken: true },
  { id: "input-array-nao-dict", contentType: "application/json", body: '{"model": "m", "input": ["x"]}', withAuth: false, expectedStatus: 422, excuseTypeToken: true },
  { id: "input-vazio-com-auth", contentType: "application/json", body: '{"model": "m", "input": ""}', withAuth: true, expectedStatus: 400 },
  { id: "input-lista-vazia-com-auth", contentType: "application/json", body: '{"model": "m", "input": []}', withAuth: true, expectedStatus: 400 },
  { id: "input-item-sem-role-com-auth", contentType: "application/json", body: '{"model": "m", "input": [{"content": "x"}]}', withAuth: true, expectedStatus: 400 },
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

/** loc[2] (index 2, right after "body","input") is the Pydantic type-name
 * token — its exact spelling is excused, its PRESENCE (a string) and every
 * other position/field is not. */
function normalizeTypeToken(body: string): { text: string; shapeOk: boolean } {
  let parsed: { detail?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { text: body, shapeOk: false };
  }
  const details = parsed.detail;
  const shapeOk =
    Array.isArray(details) &&
    details.length === 2 &&
    details.every((detail) => {
      const loc = detail["loc"];
      return (
        Array.isArray(loc) && loc.length >= 3 && loc[0] === "body" && loc[1] === "input" && typeof loc[2] === "string"
      );
    });
  if (shapeOk && Array.isArray(details)) {
    for (const detail of details) (detail["loc"] as unknown[])[2] = "<TYPE-TOKEN>";
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
            "/v1/responses",
            testCase.contentType,
            testCase.body,
            testCase.withAuth ? `Authorization: Bearer ${apiKey ?? ""}\n` : "",
          ),
        testCase.body,
      ),
    );
  }

  const rawEvidence = probes.map((entry) => ({ id: entry.id, request: entry.request, oracle: entry.oracle, candidate: entry.candidate }));
  const casesById = new Map(CASES.map((testCase) => [testCase.id, testCase]));

  const differences: unknown[] = [];
  const projectedProbes = probes.map((entry) => {
    const testCase = casesById.get(entry.id);
    const isMalformed = entry.id === "json-malformed";
    const excuseTypeToken = testCase?.excuseTypeToken === true;
    const oracleNorm = isMalformed
      ? normalizeJsonInvalid(entry.oracle.body)
      : excuseTypeToken
        ? normalizeTypeToken(entry.oracle.body)
        : { text: entry.oracle.body, shapeOk: true };
    const candidateNorm = isMalformed
      ? normalizeJsonInvalid(entry.candidate.body)
      : excuseTypeToken
        ? normalizeTypeToken(entry.candidate.body)
        : { text: entry.candidate.body, shapeOk: true };
    const comparison = compareRaw(entry.oracle, entry.candidate, {
      oracleBody: oracleNorm.text,
      candidateBody: candidateNorm.text,
      extraDroppedHeaders: isMalformed ? ["content-length"] : [],
    });
    const shapeOk = oracleNorm.shapeOk && candidateNorm.shapeOk;
    const expectedStatus = ` ${String(testCase?.expectedStatus)} `;
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
          path: "/v1/responses (json-malformed only)",
          rule: "detail[0].loc[1] and detail[0].ctx.error excused per assertion 21; content-length dropped since it reflects the true (differing) excused-message byte count.",
        },
        {
          path: "/v1/responses (input-numerico, input-array-nao-dict)",
          rule: "detail[*].loc[2] (Pydantic type-name token) excused per assertion 21's Responses row; entry count (2), order, type, msg, input and every other loc position stay exact.",
        },
        { path: "*", rule: "`date`/`server` headers dropped; header order not compared." },
      ],
    },
    rawEvidence,
    match,
    differences,
    expectedUpstreamRequests: 0,
  };
}
