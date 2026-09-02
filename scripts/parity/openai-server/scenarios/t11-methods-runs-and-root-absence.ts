// Assertions 23 (POST /v1/models and OPTIONS /v1/chat/completions -> 405
// {"detail":"Method Not Allowed"}; GET / -> 404 {"detail":"Not Found"}) and
// 24 (GET|POST /v1/runs and GET /v1/runs/abc, with and without auth, all
// 404 natural {"detail":"Not Found"} — no runs route/handler/model exists
// at all).
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

interface CaseSpec {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly withAuth: boolean;
  readonly expectedStatus: 404 | 405;
}

const CASES: readonly CaseSpec[] = [
  { id: "post-models", method: "POST", path: "/v1/models", withAuth: true, expectedStatus: 405 },
  { id: "options-chat-completions", method: "OPTIONS", path: "/v1/chat/completions", withAuth: true, expectedStatus: 405 },
  { id: "get-root", method: "GET", path: "/", withAuth: false, expectedStatus: 404 },
  { id: "get-runs-no-auth", method: "GET", path: "/v1/runs", withAuth: false, expectedStatus: 404 },
  { id: "get-runs-with-auth", method: "GET", path: "/v1/runs", withAuth: true, expectedStatus: 404 },
  { id: "post-runs-no-auth", method: "POST", path: "/v1/runs", withAuth: false, expectedStatus: 404 },
  { id: "post-runs-with-auth", method: "POST", path: "/v1/runs", withAuth: true, expectedStatus: 404 },
  { id: "get-runs-abc-no-auth", method: "GET", path: "/v1/runs/abc", withAuth: false, expectedStatus: 404 },
  { id: "get-runs-abc-with-auth", method: "GET", path: "/v1/runs/abc", withAuth: true, expectedStatus: 404 },
];

function requestLines(method: string, path: string, authLine: string): string {
  return `${method} ${path} HTTP/1.1\nHost: 127.0.0.1\n${authLine}Connection: close\n`;
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
      await probeBoth(testCase.id, oracle, candidate, (apiKey) =>
        requestLines(testCase.method, testCase.path, testCase.withAuth ? `Authorization: Bearer ${apiKey ?? ""}\n` : ""),
      ),
    );
  }

  const rawEvidence = probes.map((entry) => ({ id: entry.id, request: entry.request, oracle: entry.oracle, candidate: entry.candidate }));
  const casesById = new Map(CASES.map((testCase) => [testCase.id, testCase]));

  const differences: unknown[] = [];
  const projectedProbes = probes.map((entry) => {
    const testCase = casesById.get(entry.id);
    const expectedBody = testCase?.expectedStatus === 405 ? '{"detail":"Method Not Allowed"}' : '{"detail":"Not Found"}';
    const comparison = compareRaw(entry.oracle, entry.candidate);
    const expectedStatus = ` ${String(testCase?.expectedStatus)} `;
    const statusOk = entry.oracle.statusLine.includes(expectedStatus) && entry.candidate.statusLine.includes(expectedStatus);
    const bodyOk = entry.oracle.body === expectedBody && entry.candidate.body === expectedBody;
    const ok = comparison.match && statusOk && bodyOk;
    const record = { id: entry.id, expectedStatus: expectedStatus.trim(), expectedBody, match: ok };
    if (!ok) differences.push({ ...record, normalized: { oracle: comparison.oracle, candidate: comparison.candidate } });
    return record;
  });

  const match = differences.length === 0;
  return {
    projection: {
      probes: projectedProbes,
      normalizations: [{ path: "*", rule: "`date`/`server` headers dropped; header order not compared." }],
    },
    rawEvidence,
    match,
    differences,
    expectedUpstreamRequests: 0,
  };
}
