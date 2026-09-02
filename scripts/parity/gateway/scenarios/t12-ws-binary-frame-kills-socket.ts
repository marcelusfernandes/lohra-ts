// Promotion of E1 item 8 (Evaluator round 1): a single WS binary-opcode
// frame kills the socket with NO close frame, NO close code, NO JSON-RPC
// error -- the process and every other concurrent socket survive (L6,
// contract group D, assertion 24). The contract fixes only the wire/
// process observable, not the internal mechanism, so this never asserts
// on an exception type -- only on what a client on the wire actually
// sees. The Evaluator's own R-1 retraction is the reason this needs the
// `closed` promise rather than close-frame decoding: the correct signal
// is "connection died with nothing on the wire", not a close code (1006
// is a client-side-only sentinel the RFC forbids ON the wire).
import { connectRawWs, type RawWsClient } from "../raw-ws-client.js";
import { divergent, match, probeBoth, type NamedScenario } from "../scenario-helpers.js";

interface BinaryFrameOutcome {
  readonly diedWithoutFrame: boolean;
  readonly gotAFrame: boolean;
}

async function observeBinaryFrame(port: number): Promise<BinaryFrameOutcome> {
  const victim: RawWsClient = await connectRawWs("127.0.0.1", port, "/api/ws");
  await victim.nextFrame(); // drain gateway.ready
  victim.sendBinary(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"session.list"}', "utf8"));

  let gotAFrame = false;
  const outcome = await Promise.race([
    victim.nextFrame(4000).then(() => {
      gotAFrame = true;
      return "frame" as const;
    }),
    victim.closed.then(() => "closed" as const),
    new Promise<"timeout">((resolvePromise) => setTimeout(() => { resolvePromise("timeout"); }, 4500)),
  ]);
  victim.close();
  return { diedWithoutFrame: outcome === "closed" && !gotAFrame, gotAFrame };
}

export const BINARY_FRAME_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-ws-binary-frame-kills-socket-no-close-code",
    run: async (ctx) => {
      const id = "t12-ws-binary-frame-kills-socket-no-close-code";
      const [oracleOutcome, candidateOutcome] = await Promise.all([
        observeBinaryFrame(ctx.oraclePort),
        observeBinaryFrame(ctx.candidatePort),
      ]);
      if (oracleOutcome.diedWithoutFrame !== candidateOutcome.diedWithoutFrame) {
        return divergent(id, `oracle=${JSON.stringify(oracleOutcome)} candidate=${JSON.stringify(candidateOutcome)}`);
      }
      if (!oracleOutcome.diedWithoutFrame) {
        return divergent(id, "expected the socket to die with no frame at all on both sides", { oracleOutcome, candidateOutcome });
      }

      // A second, independent socket on each side must survive.
      const [oracleOther, candidateOther] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleOther.nextFrame(), candidateOther.nextFrame()]); // gateway.ready
        oracleOther.sendText(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session.list", params: {} }));
        candidateOther.sendText(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session.list", params: {} }));
        const [oracleReply, candidateReply] = await Promise.all([oracleOther.nextFrame(5000), candidateOther.nextFrame(5000)]);
        const oracleOk = oracleReply.payload.toString("utf8").includes('"result"');
        const candidateOk = candidateReply.payload.toString("utf8").includes('"result"');
        if (oracleOk !== candidateOk || !oracleOk) {
          return divergent(id, `other socket survival: oracle=${String(oracleOk)} candidate=${String(candidateOk)}`);
        }
      } finally {
        oracleOther.close();
        candidateOther.close();
      }

      // The process itself (not just this one connection) must still be
      // answering plain HTTP.
      const { oracle: oracleStatus, candidate: candidateStatus } = await probeBoth(ctx, "/api/status", []);
      if (oracleStatus.status !== candidateStatus.status) {
        return divergent(id, `process alive: oracle=${String(oracleStatus.status)} candidate=${String(candidateStatus.status)}`);
      }

      return match(id, { oracleOutcome, candidateOutcome, otherSocketSurvived: true, processStatus: oracleStatus.status });
    },
  },
];
