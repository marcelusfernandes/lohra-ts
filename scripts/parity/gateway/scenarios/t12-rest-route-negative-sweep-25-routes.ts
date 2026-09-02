// Promotion of E1 item 10 (Evaluator round 1): the 25 documented-and-absent
// REST routes, probed with and without a valid token (assertion 18), plus
// GET /health -> 404 (the most likely T11-copy-paste bug, assertion 13).
// Reuses the candidate's OWN route table (documentedAndAbsentRestRoutes())
// as the vector list -- the bilateral comparison against the oracle is
// what proves the shapes, not a second hand-maintained copy of the list.
import { documentedAndAbsentRestRoutes } from "../../../../src/gateway/http/routes.js";
import { divergent, match, probeBoth, type NamedScenario } from "../scenario-helpers.js";

export const REST_25_SWEEP_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-rest-route-negative-sweep-25-routes",
    run: async (ctx) => {
      const id = "t12-rest-route-negative-sweep-25-routes";
      const t = ctx.dashboardToken;
      const routes = documentedAndAbsentRestRoutes();
      let checked = 0;
      for (const route of routes) {
        const headersWithToken: readonly (readonly [string, string])[] =
          t === undefined ? [] : [["X-Lohra-Session-Token", t]];
        const withToken = await probeBoth(ctx, route.path, headersWithToken, route.method);
        if (withToken.oracle.status !== withToken.candidate.status) {
          return divergent(
            id,
            `${route.method} ${route.path} (with token): oracle=${String(withToken.oracle.status)} candidate=${String(withToken.candidate.status)}`,
          );
        }
        const noToken = await probeBoth(ctx, route.path, [], route.method);
        if (noToken.oracle.status !== noToken.candidate.status) {
          return divergent(
            id,
            `${route.method} ${route.path} (no token): oracle=${String(noToken.oracle.status)} candidate=${String(noToken.candidate.status)}`,
          );
        }
        checked += 1;
      }
      return match(id, { routesChecked: checked, probesChecked: checked * 2 });
    },
  },
  {
    id: "t12-health-route-absent-not-t11-copypaste",
    run: async (ctx) => {
      const id = "t12-health-route-absent-not-t11-copypaste";
      const { oracle, candidate } = await probeBoth(ctx, "/health", []);
      if (oracle.status !== candidate.status) {
        return divergent(
          id,
          `oracle=${String(oracle.status)} candidate=${String(candidate.status)}`,
        );
      }
      if (oracle.status !== 404) {
        return divergent(
          id,
          `expected 404 (T12 gateway has no /health route, unlike T11's server), both sides got ${String(oracle.status)}`,
        );
      }
      return match(id, { status: oracle.status });
    },
  },
];
