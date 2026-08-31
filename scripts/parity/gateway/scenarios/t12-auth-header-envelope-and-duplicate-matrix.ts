// Promotion of E1 item 2 (Evaluator round 1): the 14-variant auth-header
// matrix -- including the OWS trap (trailing space rejected, leading space
// accepted, per review R6) and first-wins duplicate-header semantics --
// previously proven only by TDD-tier unit tests (tests/gateway/auth.test.ts).
// Purely bilateral: no literal status is hard-coded, since the point is
// whatever the oracle's own OWS/case/duplicate handling actually is.
import { sendRawHttpRequest, type RawHttpResponse } from "../raw-http-client.js";
import { divergent, jsonBody, match, type NamedScenario, type ScenarioContext } from "../scenario-helpers.js";

const TOKEN_HEADER = "X-Lohra-Session-Token";

interface Variant {
  readonly name: string;
  readonly headers: readonly (readonly [string, string])[];
}

async function probeVariant(
  ctx: ScenarioContext,
  variant: Variant,
): Promise<{ readonly oracle: RawHttpResponse; readonly candidate: RawHttpResponse }> {
  const headers = [...variant.headers, ["Host", "127.0.0.1"], ["Connection", "close"]] as const;
  const [oracle, candidate] = await Promise.all([
    sendRawHttpRequest("127.0.0.1", ctx.oraclePort, { method: "GET", path: "/api/status", headers }),
    sendRawHttpRequest("127.0.0.1", ctx.candidatePort, { method: "GET", path: "/api/status", headers }),
  ]);
  return { oracle, candidate };
}

export const AUTH_HEADER_MATRIX_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-auth-header-envelope-and-duplicate-matrix",
    run: async (ctx) => {
      const id = "t12-auth-header-envelope-and-duplicate-matrix";
      if (ctx.dashboardToken === undefined) {
        return divergent(id, "scenario requires a pinned dashboardToken (SECURE_PHASE_DASHBOARD_TOKEN) but ctx.dashboardToken is undefined");
      }
      const t = ctx.dashboardToken;
      const variants: readonly Variant[] = [
        { name: "auth_absent", headers: [] },
        { name: "auth_empty", headers: [[TOKEN_HEADER, ""]] },
        { name: "auth_wrong", headers: [[TOKEN_HEADER, "wrong-token"]] },
        { name: "auth_trailing_space", headers: [[TOKEN_HEADER, `${t}  `]] },
        { name: "auth_leading_space", headers: [[TOKEN_HEADER, `  ${t}`]] },
        { name: "auth_bearer_scheme", headers: [[TOKEN_HEADER, `Bearer ${t}`]] },
        { name: "auth_wrong_case_header", headers: [["x-lohra-session-token", t]] },
        { name: "auth_upper_case_header", headers: [["X-LOHRA-SESSION-TOKEN", t]] },
        { name: "auth_in_authorization_header", headers: [["Authorization", `Bearer ${t}`]] },
        { name: "auth_duplicate_good_then_bad", headers: [[TOKEN_HEADER, t], [TOKEN_HEADER, "wrong-token"]] },
        { name: "auth_duplicate_bad_then_good", headers: [[TOKEN_HEADER, "wrong-token"], [TOKEN_HEADER, t]] },
      ];

      const results: { readonly name: string; readonly oracleStatus: number; readonly candidateStatus: number }[] = [];
      for (const variant of variants) {
        const { oracle, candidate } = await probeVariant(ctx, variant);
        if (oracle.status !== candidate.status) {
          return divergent(
            id,
            `${variant.name}: oracle=${String(oracle.status)} candidate=${String(candidate.status)}`,
            { variant: variant.name, oracleBody: jsonBody(oracle), candidateBody: jsonBody(candidate) },
          );
        }
        results.push({ name: variant.name, oracleStatus: oracle.status, candidateStatus: candidate.status });
      }
      // Query-param token must never authenticate REST (only header does).
      const viaQuery = await Promise.all([
        sendRawHttpRequest("127.0.0.1", ctx.oraclePort, {
          method: "GET",
          path: `/api/status?token=${t}`,
          headers: [["Host", "127.0.0.1"], ["Connection", "close"]],
        }),
        sendRawHttpRequest("127.0.0.1", ctx.candidatePort, {
          method: "GET",
          path: `/api/status?token=${t}`,
          headers: [["Host", "127.0.0.1"], ["Connection", "close"]],
        }),
      ]);
      if (viaQuery[0].status !== viaQuery[1].status) {
        return divergent(id, `auth_via_query_param: oracle=${String(viaQuery[0].status)} candidate=${String(viaQuery[1].status)}`);
      }
      results.push({ name: "auth_via_query_param", oracleStatus: viaQuery[0].status, candidateStatus: viaQuery[1].status });

      return match(id, { variants: results });
    },
  },
];
