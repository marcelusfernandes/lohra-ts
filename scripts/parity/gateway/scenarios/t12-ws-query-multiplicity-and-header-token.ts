// Promotion of E1 item 5 (Evaluator round 1): WS query-parameter
// multiplicity (last-wins) and header-token rejection -- previously
// TDD-tier only. Needs a KNOWN valid token pinned on both sides (see
// SECURE_PHASE_DASHBOARD_TOKEN) so the "duplicate good-then-bad" /
// "duplicate bad-then-good" cases actually exercise which occurrence wins,
// rather than every combination just closing 4401 regardless.
import { connectRawWs, decodeCloseFrame, WS_OPCODE } from "../raw-ws-client.js";
import { divergent, match, type NamedScenario } from "../scenario-helpers.js";

const TOKEN_HEADER = "X-Lohra-Session-Token";

interface Outcome {
  readonly status: number;
  readonly kind: "ready" | "close" | "other";
  readonly closeCode: number | null;
}

async function observe(port: number, path: string, extraHeaders: readonly (readonly [string, string])[] = []): Promise<Outcome> {
  const ws = await connectRawWs("127.0.0.1", port, path, extraHeaders);
  try {
    if (ws.handshake.status !== 101) return { status: ws.handshake.status, kind: "other", closeCode: null };
    const frame = await ws.nextFrame(5000);
    if (frame.opcode === WS_OPCODE.close) {
      return { status: ws.handshake.status, kind: "close", closeCode: decodeCloseFrame(frame.payload).code };
    }
    if (frame.opcode === WS_OPCODE.text && frame.payload.toString("utf8").includes("gateway.ready")) {
      return { status: ws.handshake.status, kind: "ready", closeCode: null };
    }
    return { status: ws.handshake.status, kind: "other", closeCode: null };
  } finally {
    ws.close();
  }
}

export const WS_QUERY_AND_HEADER_TOKEN_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-ws-query-multiplicity-last-wins",
    run: async (ctx) => {
      const id = "t12-ws-query-multiplicity-last-wins";
      if (ctx.dashboardToken === undefined) {
        return divergent(id, "scenario requires a pinned dashboardToken but ctx.dashboardToken is undefined");
      }
      const t = ctx.dashboardToken;
      const cases: readonly { readonly name: string; readonly path: string }[] = [
        { name: "dup_good_then_bad", path: `/api/ws?token=${t}&token=wrong` },
        { name: "dup_bad_then_good", path: `/api/ws?token=wrong&token=${t}` },
        { name: "ticket_param", path: "/api/ws?ticket=whatever" },
        { name: "internal_param", path: "/api/ws?internal=whatever" },
      ];
      const results: Record<string, { readonly oracle: Outcome; readonly candidate: Outcome }> = {};
      for (const { name, path } of cases) {
        const [oracle, candidate] = await Promise.all([observe(ctx.oraclePort, path), observe(ctx.candidatePort, path)]);
        results[name] = { oracle, candidate };
        if (oracle.status !== candidate.status || oracle.kind !== candidate.kind || oracle.closeCode !== candidate.closeCode) {
          return divergent(id, `${name}: oracle=${JSON.stringify(oracle)} candidate=${JSON.stringify(candidate)}`, results);
        }
      }
      return match(id, results);
    },
  },
  {
    id: "t12-ws-header-token-rejected",
    run: async (ctx) => {
      const id = "t12-ws-header-token-rejected";
      if (ctx.dashboardToken === undefined) {
        return divergent(id, "scenario requires a pinned dashboardToken but ctx.dashboardToken is undefined");
      }
      // The token in a header instead of the query string must be
      // rejected the same way an absent token is -- the WS layer only
      // ever reads it from ?token=.
      const [oracle, candidate] = await Promise.all([
        observe(ctx.oraclePort, "/api/ws", [[TOKEN_HEADER, ctx.dashboardToken]]),
        observe(ctx.candidatePort, "/api/ws", [[TOKEN_HEADER, ctx.dashboardToken]]),
      ]);
      if (oracle.status !== candidate.status || oracle.kind !== candidate.kind || oracle.closeCode !== candidate.closeCode) {
        return divergent(id, `oracle=${JSON.stringify(oracle)} candidate=${JSON.stringify(candidate)}`);
      }
      return match(id, { oracle, candidate });
    },
  },
];
