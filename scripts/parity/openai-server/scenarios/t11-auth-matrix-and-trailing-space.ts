// Assertions 17 (absence/empty, wrong Bearer, lowercase bearer, Basic and a
// raw token all 401 with the exact compact body; `Bearer <correct>  ` passes
// after trim), 19 (`--insecure` accepts ANY Authorization and never prints
// "API key:"; without it, LOHRA_OPENAI_API_KEY is honored and the key line
// appears in stderr — captured only scrubbed by writeEvidence's default
// redaction). Registered twice in run-all.ts (secured + insecure config) —
// this file branches on `handle.apiKey` (null under --insecure) rather than
// hardcoding which mode it runs under.
import { compareRaw, probeBoth, type ProbeRecord, type ServerHandle } from "../harness.js";

function modelsRequest(authLine: string): string {
  return `GET /v1/models HTTP/1.1\nHost: 127.0.0.1\n${authLine}Connection: close\n`;
}

const UNAUTHORIZED_BODY =
  '{"error":{"message":"missing or invalid API key","type":"authentication_error"}}';

interface SecuredCase {
  readonly id: string;
  readonly authLine: (correctKey: string) => string;
  readonly expectedStatus: 401 | 200;
}

const SECURED_CASES: readonly SecuredCase[] = [
  { id: "no-auth-header", authLine: () => "", expectedStatus: 401 },
  { id: "empty-bearer", authLine: () => "Authorization: Bearer \n", expectedStatus: 401 },
  {
    id: "wrong-bearer",
    authLine: () => "Authorization: Bearer not-the-real-key\n",
    expectedStatus: 401,
  },
  {
    id: "lowercase-bearer",
    authLine: (key) => `Authorization: bearer ${key}\n`,
    expectedStatus: 401,
  },
  { id: "basic-scheme", authLine: () => "Authorization: Basic zzz\n", expectedStatus: 401 },
  { id: "raw-token-no-scheme", authLine: (key) => `Authorization: ${key}\n`, expectedStatus: 401 },
  {
    id: "correct-with-trailing-spaces",
    authLine: (key) => `Authorization: Bearer ${key}  \n`,
    expectedStatus: 200,
  },
];

const INSECURE_CASES: readonly { readonly id: string; readonly authLine: string }[] = [
  { id: "insecure-no-auth", authLine: "" },
  { id: "insecure-basic-zzz", authLine: "Authorization: Basic zzz\n" },
  { id: "insecure-wrong-bearer", authLine: "Authorization: Bearer not-a-real-key\n" },
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
  const insecure = oracle.apiKey === null && candidate.apiKey === null;
  const probes: ProbeRecord[] = [];
  const expectedStatusById = new Map<string, number>();

  if (insecure) {
    for (const testCase of INSECURE_CASES) {
      probes.push(
        await probeBoth(testCase.id, oracle, candidate, () => modelsRequest(testCase.authLine)),
      );
      expectedStatusById.set(testCase.id, 200);
    }
  } else {
    for (const testCase of SECURED_CASES) {
      probes.push(
        await probeBoth(testCase.id, oracle, candidate, (apiKey) =>
          modelsRequest(testCase.authLine(apiKey ?? "")),
        ),
      );
      expectedStatusById.set(testCase.id, testCase.expectedStatus);
    }
  }

  const rawEvidence = {
    probes: probes.map((entry) => ({
      id: entry.id,
      request: entry.request,
      oracle: entry.oracle,
      candidate: entry.candidate,
    })),
    oracleStderr: oracle.stderr(),
    candidateStderr: candidate.stderr(),
  };

  const differences: unknown[] = [];
  const projectedProbes = probes.map((entry) => {
    const expectedStatus = ` ${String(expectedStatusById.get(entry.id))} `;
    const statusOk =
      entry.oracle.statusLine.includes(expectedStatus) &&
      entry.candidate.statusLine.includes(expectedStatus);
    const bodyOk =
      expectedStatus.trim() !== "401" ||
      (entry.oracle.body === UNAUTHORIZED_BODY && entry.candidate.body === UNAUTHORIZED_BODY);
    const comparison = compareRaw(entry.oracle, entry.candidate, {
      // 200 bodies are the full /v1/models list, already bilaterally proven
      // byte-exact (modulo `created`) by t11-surface-health-models-docs;
      // here we only care that AUTH decided the same way on both sides, so
      // the body itself is excluded from this comparison to avoid
      // duplicating that normalization.
      oracleBody: expectedStatus.trim() === "200" ? "<MODELS-BODY>" : entry.oracle.body,
      candidateBody: expectedStatus.trim() === "200" ? "<MODELS-BODY>" : entry.candidate.body,
      extraDroppedHeaders: expectedStatus.trim() === "200" ? ["content-length"] : [],
    });
    const ok = comparison.match && statusOk && bodyOk;
    const record = { id: entry.id, expectedStatus: expectedStatus.trim(), match: ok };
    if (!ok)
      differences.push({
        ...record,
        normalized: { oracle: comparison.oracle, candidate: comparison.candidate },
      });
    return record;
  });

  // Assertion 19: the key-echo line is present (redacted at evidence time)
  // exactly when the server is NOT insecure, absent when it is.
  const keyLinePresentOracle = /API key: /u.test(oracle.stderr());
  const keyLinePresentCandidate = /API key: /u.test(candidate.stderr());
  const stderrOk = insecure
    ? !keyLinePresentOracle && !keyLinePresentCandidate
    : keyLinePresentOracle && keyLinePresentCandidate;
  if (!stderrOk)
    differences.push({
      id: "stderr-key-line",
      insecure,
      keyLinePresentOracle,
      keyLinePresentCandidate,
    });

  const match = differences.length === 0;
  return {
    projection: {
      insecure,
      probes: projectedProbes,
      stderrOk,
      normalizations: [
        {
          path: "/v1/models (200 cases)",
          rule: "body excluded from this scenario's comparison — byte-exact list shape already proven in t11-surface-health-models-docs; here only the auth decision (status) matters.",
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
