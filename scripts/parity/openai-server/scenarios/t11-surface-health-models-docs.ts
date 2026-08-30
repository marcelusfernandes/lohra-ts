// Assertions 13 (eight observable handlers), 15 (/health shape + HEAD 405),
// 16 (/v1/models shape, auth, ordering) and 14's non-redirect half
// (/openapi.json paths + the three doc HTML routes, no auth). The trailing
// slash redirect-as-router-class half of 14 lives in
// t11-route-negative-sweep-and-slash-redirect-class instead.
import { headerValue, sendRaw, type RawResponse, type ServerHandle } from "../harness.js";

interface Probe {
  readonly id: string;
  readonly oracle: RawResponse;
  readonly candidate: RawResponse;
}

const DOC_PATHS = ["/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect"] as const;
const PRODUCT_PATHS = ["/health", "/v1/chat/completions", "/v1/models", "/v1/responses"].toSorted();

/** Assertion 14 only pins `/openapi.json`'s `paths` key-set and the three
 * doc routes' status/content-type — FastAPI's actual Swagger/ReDoc HTML is
 * CDN-templated boilerplate no hand-rolled TS page is expected to
 * byte-replicate. Checked per side, not bilaterally diffed. */
function checkDocResponse(path: string, response: RawResponse): string[] {
  const problems: string[] = [];
  if (!response.statusLine.includes(" 200 ")) problems.push(`status:${response.statusLine}`);
  const contentType = response.headers.find(([name]) => name === "content-type")?.[1] ?? "";
  if (path === "/openapi.json") {
    if (!contentType.startsWith("application/json")) problems.push(`content-type:${contentType}`);
    try {
      const parsed = JSON.parse(response.body) as { paths?: Record<string, unknown> };
      const keys = Object.keys(parsed.paths ?? {}).toSorted();
      if (JSON.stringify(keys) !== JSON.stringify(PRODUCT_PATHS)) problems.push(`paths:${JSON.stringify(keys)}`);
    } catch {
      problems.push("openapi-json-parse-failed");
    }
  } else if (!contentType.startsWith("text/html")) {
    problems.push(`content-type:${contentType}`);
  }
  return problems;
}

function normalizeModelsBody(body: string): { text: string; createdIsInteger: boolean } {
  let createdIsInteger = true;
  let parsed: { object?: string; data?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { text: body, createdIsInteger: false };
  }
  for (const item of parsed.data ?? []) {
    const created = item["created"];
    if (typeof created !== "number" || !Number.isInteger(created)) createdIsInteger = false;
    item["created"] = 0;
  }
  return { text: JSON.stringify(parsed), createdIsInteger };
}

/** Header field ORDER is not governed by the contract (assertion 9 only
 * pins body key order) — sort so the comparison isn't a false positive on
 * ordering alone. `date`/`server` are declared-normalized away entirely. */
function stripVolatileHeaders(headers: RawResponse["headers"]): Record<string, string> {
  return Object.fromEntries(
    headers.filter(([name]) => name !== "date" && name !== "server").toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

async function probe(
  id: string,
  oracle: ServerHandle,
  candidate: ServerHandle,
  requestLines: (apiKey: string | null) => string,
): Promise<Probe> {
  const [oracleResponse, candidateResponse] = await Promise.all([
    sendRaw(oracle.port, requestLines(oracle.apiKey)),
    sendRaw(candidate.port, requestLines(candidate.apiKey)),
  ]);
  return { id, oracle: oracleResponse, candidate: candidateResponse };
}

export async function run(
  oracle: ServerHandle,
  candidate: ServerHandle,
): Promise<{ projection: unknown; match: boolean; differences: unknown[] }> {
  const probes: Probe[] = [];

  probes.push(
    await probe("health-ok", oracle, candidate, () => "GET /health HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n"),
  );
  probes.push(
    await probe(
      "health-ignores-bad-auth",
      oracle,
      candidate,
      () => "GET /health HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer not-a-real-key\nConnection: close\n",
    ),
  );
  probes.push(
    await probe("health-head-405", oracle, candidate, () => "HEAD /health HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n"),
  );
  probes.push(
    await probe(
      "models-with-auth",
      oracle,
      candidate,
      (apiKey) =>
        `GET /v1/models HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer ${apiKey ?? ""}\nConnection: close\n`,
    ),
  );
  for (const path of DOC_PATHS) {
    probes.push(await probe(`doc:${path}`, oracle, candidate, () => `GET ${path} HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n`));
  }

  const differences: unknown[] = [];
  const projectedProbes = probes.map((entry) => {
    const docPath = DOC_PATHS.find((path) => entry.id === `doc:${path}`);
    if (docPath !== undefined) {
      const oracleProblems = checkDocResponse(docPath, entry.oracle);
      const candidateProblems = checkDocResponse(docPath, entry.candidate);
      const ok = oracleProblems.length === 0 && candidateProblems.length === 0;
      const record = { id: entry.id, oracleProblems, candidateProblems, match: ok };
      if (!ok) differences.push(record);
      return record;
    }
    const isModels = entry.id === "models-with-auth";
    const oracleBody = isModels ? normalizeModelsBody(entry.oracle.body) : { text: entry.oracle.body, createdIsInteger: true };
    const candidateBody = isModels
      ? normalizeModelsBody(entry.candidate.body)
      : { text: entry.candidate.body, createdIsInteger: true };
    const oracleSide = {
      statusLine: entry.oracle.statusLine,
      headers: stripVolatileHeaders(entry.oracle.headers),
      body: oracleBody.text,
    };
    const candidateSide = {
      statusLine: entry.candidate.statusLine,
      headers: stripVolatileHeaders(entry.candidate.headers),
      body: candidateBody.text,
    };
    const contentTypeOracle = headerValue(entry.oracle, "content-type");
    const contentTypeCandidate = headerValue(entry.candidate, "content-type");
    const bytesMatch = JSON.stringify(oracleSide) === JSON.stringify(candidateSide);
    const createdOk = !isModels || (oracleBody.createdIsInteger && candidateBody.createdIsInteger);
    const ok = bytesMatch && createdOk && contentTypeOracle === contentTypeCandidate;
    if (!ok) differences.push({ id: entry.id, oracle: oracleSide, candidate: candidateSide });
    return { id: entry.id, oracle: oracleSide, candidate: candidateSide, match: ok };
  });

  const match = differences.length === 0;
  return { projection: { probes: projectedProbes }, match, differences };
}
