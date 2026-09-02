// Assertions 13 (eight observable handlers), 15 (/health shape + HEAD 405),
// 16 (/v1/models shape, auth, ordering) and 14's non-redirect half
// (/openapi.json paths + the three doc HTML routes, no auth). The trailing
// slash redirect-as-router-class half of 14 lives in
// t11-route-negative-sweep-and-slash-redirect-class instead.
import {
  compareRaw,
  headerValue,
  probeBoth,
  type ProbeRecord,
  type RawResponse,
  type ServerHandle,
} from "../harness.js";

const DOC_PATHS = ["/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect"] as const;
const PRODUCT_PATHS = ["/health", "/v1/chat/completions", "/v1/models", "/v1/responses"].toSorted();

/** Contract-t11 assertion 14: "`/docs`, `/redoc` e `/docs/oauth2-redirect`
 * retornam 200 HTML sem auth" and "[/openapi.json] seu `paths` contém
 * exatamente os quatro paths de produto" — pins status/content-type and,
 * for openapi.json, the exact `paths` key-set. It does NOT ask a hand-rolled
 * TS page to byte-replicate FastAPI's CDN-templated Swagger/ReDoc HTML, so
 * these three are checked structurally per side, never bilaterally diffed. */
function checkDocResponse(path: string, response: RawResponse): string[] {
  const problems: string[] = [];
  if (!response.statusLine.includes(" 200 ")) problems.push(`status:${response.statusLine}`);
  const contentType = response.headers.find(([name]) => name === "content-type")?.[1] ?? "";
  if (path === "/openapi.json") {
    if (!contentType.startsWith("application/json")) problems.push(`content-type:${contentType}`);
    try {
      const parsed = JSON.parse(response.body) as { paths?: Record<string, unknown> };
      const keys = Object.keys(parsed.paths ?? {}).toSorted();
      if (JSON.stringify(keys) !== JSON.stringify(PRODUCT_PATHS))
        problems.push(`paths:${JSON.stringify(keys)}`);
    } catch {
      problems.push("openapi-json-parse-failed");
    }
  } else if (!contentType.startsWith("text/html")) {
    problems.push(`content-type:${contentType}`);
  }
  return problems;
}

/** Assertion 16: "`created`... inteiro comum a todos os itens" — every item
 * must carry the SAME integer, not merely an integer each. Verified before
 * the value is normalized away for the bilateral body comparison. */
function normalizeModelsBody(body: string): { text: string; createdOk: boolean } {
  let parsed: { object?: string; data?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { text: body, createdOk: false };
  }
  const createdValues = (parsed.data ?? []).map((item) => item["created"]);
  const createdOk =
    createdValues.every((value) => typeof value === "number" && Number.isInteger(value)) &&
    new Set(createdValues).size <= 1;
  for (const item of parsed.data ?? []) item["created"] = 0;
  return { text: JSON.stringify(parsed), createdOk };
}

const NORMALIZATIONS = [
  {
    path: "/v1/models",
    rule: "`created` checked to be an integer common to every item, then zeroed before the bilateral body diff (assertion 16).",
  },
  {
    path: "*",
    rule: "`date` and `server` response headers dropped before comparison; header field order is not compared (assertion 9 pins body key order, not header order).",
  },
  {
    path: "/openapi.json, /docs, /redoc, /docs/oauth2-redirect",
    rule: "Checked structurally per side (status 200, content-type, and for /openapi.json the exact `paths` key-set) rather than bilaterally byte-diffed — assertion 14 only pins those properties, not FastAPI's CDN-templated Swagger/ReDoc HTML body.",
  },
];

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

  probes.push(
    await probeBoth(
      "health-ok",
      oracle,
      candidate,
      () => "GET /health HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n",
    ),
  );
  probes.push(
    await probeBoth(
      "health-ignores-bad-auth",
      oracle,
      candidate,
      () =>
        "GET /health HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer not-a-real-key\nConnection: close\n",
    ),
  );
  probes.push(
    await probeBoth(
      "health-head-405",
      oracle,
      candidate,
      () => "HEAD /health HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n",
    ),
  );
  probes.push(
    await probeBoth(
      "models-with-auth",
      oracle,
      candidate,
      (apiKey) =>
        `GET /v1/models HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer ${apiKey ?? ""}\nConnection: close\n`,
    ),
  );
  for (const path of DOC_PATHS) {
    probes.push(
      await probeBoth(
        `doc:${path}`,
        oracle,
        candidate,
        () => `GET ${path} HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n`,
      ),
    );
  }

  // `rawEvidence` carries the untouched wire capture (assertion 7 — request
  // cru, status line, headers, body) INCLUDING volatile bits like the
  // `date` header. It is written to disk for debugging but deliberately
  // excluded from `projection`, which is what the digest hashes: assertion
  // 10 requires the SAME digest across two runs on one SHA, and `date`
  // changes every run.
  const rawEvidence = probes.map((entry) => ({
    id: entry.id,
    request: entry.request,
    oracle: entry.oracle,
    candidate: entry.candidate,
  }));

  const differences: unknown[] = [];
  const projectedProbes = probes.map((entry) => {
    const docPath = DOC_PATHS.find((path) => entry.id === `doc:${path}`);
    if (docPath !== undefined) {
      const oracleProblems = checkDocResponse(docPath, entry.oracle);
      const candidateProblems = checkDocResponse(docPath, entry.candidate);
      const ok = oracleProblems.length === 0 && candidateProblems.length === 0;
      const record = { id: entry.id, oracleProblems, candidateProblems, match: ok };
      if (!ok) differences.push({ ...record, oracle: entry.oracle, candidate: entry.candidate });
      return record;
    }
    const isModels = entry.id === "models-with-auth";
    const oracleBody = isModels
      ? normalizeModelsBody(entry.oracle.body)
      : { text: entry.oracle.body, createdOk: true };
    const candidateBody = isModels
      ? normalizeModelsBody(entry.candidate.body)
      : { text: entry.candidate.body, createdOk: true };
    const comparison = compareRaw(entry.oracle, entry.candidate, {
      oracleBody: oracleBody.text,
      candidateBody: candidateBody.text,
    });
    const contentTypeOracle = headerValue(entry.oracle, "content-type");
    const contentTypeCandidate = headerValue(entry.candidate, "content-type");
    const createdOk = oracleBody.createdOk && candidateBody.createdOk;
    const ok = comparison.match && createdOk && contentTypeOracle === contentTypeCandidate;
    const record = {
      id: entry.id,
      normalized: { oracle: comparison.oracle, candidate: comparison.candidate },
      match: ok,
    };
    if (!ok) differences.push(record);
    return record;
  });

  const match = differences.length === 0;
  return {
    projection: { probes: projectedProbes, normalizations: NORMALIZATIONS },
    rawEvidence,
    match,
    differences,
    expectedUpstreamRequests: 0,
  };
}
