// Promotion of E1 item 3 (Evaluator round 1): a sweep of malformed/edge-case
// raw JSON-RPC bodies -- non-object top level, missing/null/numeric
// method, malformed params, non-numeric ids, case sensitivity, whitespace
// in method names -- previously TDD-tier only. Purely bilateral: each raw
// body is sent verbatim to both sides and the response is classified by
// shape, never by a hard-coded expected value, since the point is
// agreement on framing edges, not a specific literal.
import { connectRawWs, WS_OPCODE, type RawWsClient } from "../raw-ws-client.js";
import { divergent, match, type NamedScenario } from "../scenario-helpers.js";

async function classifyNext(ws: RawWsClient, timeoutMs = 2000): Promise<string> {
  try {
    const frame = await ws.nextFrame(timeoutMs);
    if (frame.opcode !== WS_OPCODE.text) return `opcode:${String(frame.opcode)}`;
    const envelope = JSON.parse(frame.payload.toString("utf8")) as {
      readonly error?: { readonly code?: unknown };
      readonly result?: unknown;
      readonly id?: unknown;
      readonly method?: string;
      readonly params?: { readonly type?: string };
    };
    if (envelope.error !== undefined) return `rpc-error:${String(envelope.error.code)}`;
    if (envelope.result !== undefined) return `rpc-ok:${JSON.stringify(envelope.id)}`;
    if (envelope.method === "event") return `event:${String(envelope.params?.type)}`;
    return `unknown:${JSON.stringify(envelope)}`;
  } catch {
    return "no-response";
  }
}

const RAW_PROBES: readonly { readonly name: string; readonly raw: string }[] = [
  { name: "json_array", raw: "[1,2,3]" },
  { name: "json_scalar_number", raw: "42" },
  { name: "json_scalar_string", raw: '"hello"' },
  { name: "json_null", raw: "null" },
  { name: "missing_method", raw: '{"jsonrpc":"2.0","id":7}' },
  { name: "method_null", raw: '{"jsonrpc":"2.0","id":8,"method":null}' },
  { name: "method_empty_string", raw: '{"jsonrpc":"2.0","id":9,"method":""}' },
  { name: "method_number", raw: '{"jsonrpc":"2.0","id":10,"method":5}' },
  { name: "unknown_method", raw: '{"jsonrpc":"2.0","id":11,"method":"nope.nope"}' },
  { name: "params_list", raw: '{"jsonrpc":"2.0","id":12,"method":"session.list","params":[1]}' },
  { name: "params_string", raw: '{"jsonrpc":"2.0","id":13,"method":"session.list","params":"x"}' },
  { name: "params_null", raw: '{"jsonrpc":"2.0","id":14,"method":"session.list","params":null}' },
  { name: "no_jsonrpc_field", raw: '{"id":15,"method":"session.list"}' },
  { name: "jsonrpc_wrong_version", raw: '{"jsonrpc":"1.0","id":16,"method":"session.list"}' },
  { name: "notification_no_id", raw: '{"jsonrpc":"2.0","method":"session.list"}' },
  { name: "id_string", raw: '{"jsonrpc":"2.0","id":"abc","method":"session.list"}' },
  { name: "id_object", raw: '{"jsonrpc":"2.0","id":{"k":1},"method":"session.list"}' },
  {
    name: "extra_top_level_keys",
    raw: '{"jsonrpc":"2.0","id":17,"method":"session.list","extra":true}',
  },
  { name: "p2_session_steer", raw: '{"jsonrpc":"2.0","id":20,"method":"session.steer"}' },
  { name: "case_sensitivity", raw: '{"jsonrpc":"2.0","id":30,"method":"Session.List"}' },
  { name: "method_whitespace", raw: '{"jsonrpc":"2.0","id":31,"method":" session.list "}' },
];

export const RPC_FRAMING_EDGES_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-rpc-framing-edges-33-probes",
    run: async (ctx) => {
      const id = "t12-rpc-framing-edges-33-probes";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]); // drain gateway.ready
        const results: Record<string, { readonly oracle: string; readonly candidate: string }> = {};
        for (const probeCase of RAW_PROBES) {
          oracleWs.sendText(probeCase.raw);
          candidateWs.sendText(probeCase.raw);
          const [oracleOutcome, candidateOutcome] = await Promise.all([
            classifyNext(oracleWs),
            classifyNext(candidateWs),
          ]);
          results[probeCase.name] = { oracle: oracleOutcome, candidate: candidateOutcome };
          if (oracleOutcome !== candidateOutcome) {
            return divergent(
              id,
              `${probeCase.name}: oracle=${oracleOutcome} candidate=${candidateOutcome}`,
              results,
            );
          }
        }
        return match(id, { n: RAW_PROBES.length, results });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },
];
