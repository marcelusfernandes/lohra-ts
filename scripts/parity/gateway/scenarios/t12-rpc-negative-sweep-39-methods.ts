// Promotion of the [probe-complementar] `t12-rpc-negative-sweep-39-methods`
// (assertion 51) from in-process-only to raw-socket principal evidence.
// tests/gateway/rpc-dispatch.test.ts already proves the DISPATCH TABLE
// itself is complete and literal (calling dispatchSyncRpc() directly, no
// socket) -- but that alone never proves a real client sending
// {"method":"session.steer",...} over the actual WS connection reaches
// this table at all. This closes exactly that wire-level gap (named as an
// open limit in this ticket's own handoff report, §4): every one of the
// 39 documented-and-absent RPC methods, sent over a real raw WS
// connection, checked bilaterally against the oracle.
import { DOCUMENTED_AND_ABSENT_RPC_METHODS } from "../../../../src/gateway/rpc/dispatch.js";
import { connectRawWs } from "../raw-ws-client.js";
import { divergent, match, type NamedScenario } from "../scenario-helpers.js";

export const RPC_NEGATIVE_SWEEP_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-rpc-negative-sweep-39-methods",
    run: async (ctx) => {
      const id = "t12-rpc-negative-sweep-39-methods";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]); // drain gateway.ready

        const results: Record<string, { readonly oracle: unknown; readonly candidate: unknown }> = {};
        let rpcId = 100;
        for (const method of DOCUMENTED_AND_ABSENT_RPC_METHODS) {
          const requestId = rpcId;
          rpcId += 1;
          oracleWs.sendText(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: {} }));
          candidateWs.sendText(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: {} }));
          const [oracleFrame, candidateFrame] = await Promise.all([oracleWs.nextFrame(5000), candidateWs.nextFrame(5000)]);
          const oracleEnvelope = JSON.parse(oracleFrame.payload.toString("utf8")) as { readonly error?: { readonly code?: unknown } };
          const candidateEnvelope = JSON.parse(candidateFrame.payload.toString("utf8")) as { readonly error?: { readonly code?: unknown } };
          results[method] = { oracle: oracleEnvelope.error?.code, candidate: candidateEnvelope.error?.code };
          if (oracleEnvelope.error?.code !== candidateEnvelope.error?.code) {
            return divergent(id, `${method}: oracle=${JSON.stringify(oracleEnvelope)} candidate=${JSON.stringify(candidateEnvelope)}`, results);
          }
          if (oracleEnvelope.error?.code !== -32601) {
            return divergent(id, `${method}: expected -32601 on both sides, both got ${JSON.stringify(oracleEnvelope.error?.code)}`, results);
          }
        }

        return match(id, { methodsChecked: DOCUMENTED_AND_ABSENT_RPC_METHODS.length, results });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },
];
