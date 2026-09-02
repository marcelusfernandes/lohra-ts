// Promotion of E1 item 6 (Evaluator round 1): L20/assertion 47 -- with a
// turn genuinely in flight on one socket, three OTHER concurrent sockets
// submitting to the SAME session all get {"code":4009,"message":"session
// busy"}, and no separate `error` event is emitted for any of them.
//
// The fake upstream's holdNextStream() is a SINGLE global slot shared by
// BOTH the oracle and candidate processes (they hit the same upstream
// instance) -- running the oracle-side and candidate-side race
// concurrently would race for that one slot and starve whichever side
// asks second. Each side's race runs to completion, sequentially, before
// the other starts.
import { connectRawWs, type RawWsClient } from "../raw-ws-client.js";
import { divergent, drainUntilComplete, match, type NamedScenario, type ScenarioContext } from "../scenario-helpers.js";

interface SideRaceResult {
  readonly winnerCompleted: boolean;
  readonly loserResponses: readonly unknown[];
}

async function raceOneSide(port: number, fakeUpstream: ScenarioContext["fakeUpstream"]): Promise<SideRaceResult> {
  fakeUpstream.setNextContent("busy race reply");
  const hold = fakeUpstream.holdNextStream();
  let held = true;
  const releaseOnce = (): void => {
    if (held) {
      held = false;
      hold.release();
    }
  };

  const winner: RawWsClient = await connectRawWs("127.0.0.1", port, "/api/ws");
  const losers: RawWsClient[] = [];
  try {
    await winner.nextFrame(); // gateway.ready
    winner.sendText(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create", params: {} }));
    const createFrame = await winner.nextFrame();
    const sessionId = (JSON.parse(createFrame.payload.toString("utf8")) as { result?: { session_id?: string } }).result?.session_id ?? "";

    winner.sendText(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: sessionId, text: "hold me open" } }));
    let sawMessageStart = false;
    for (let i = 0; i < 6 && !sawMessageStart; i += 1) {
      const frame = await winner.nextFrame(5000);
      const envelope = JSON.parse(frame.payload.toString("utf8")) as { method?: string; params?: { type?: string } };
      if (envelope.method === "event" && envelope.params?.type === "message.start") sawMessageStart = true;
    }
    if (!sawMessageStart) {
      releaseOnce();
      throw new Error("never observed message.start before racing the 3 loser sockets");
    }

    let loserResponses: unknown[] = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        const loser = await connectRawWs("127.0.0.1", port, "/api/ws");
        losers.push(loser);
        await loser.nextFrame(); // gateway.ready
      }
      loserResponses = await Promise.all(
        losers.map(async (loser, index) => {
          loser.sendText(
            JSON.stringify({ jsonrpc: "2.0", id: 10 + index, method: "prompt.submit", params: { session_id: sessionId, text: "should be busy" } }),
          );
          const frame = await loser.nextFrame(5000);
          return JSON.parse(frame.payload.toString("utf8")) as unknown;
        }),
      );
    } finally {
      releaseOnce();
    }

    const drained = await drainUntilComplete(winner);
    const winnerCompleted = drained.some((event) => event.type === "message.complete");
    return { winnerCompleted, loserResponses };
  } finally {
    releaseOnce();
    for (const loser of losers) loser.close();
    winner.close();
  }
}

export const BUSY_4009_MULTISOCKET_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-busy-4009-multisocket-race",
    run: async (ctx) => {
      const id = "t12-busy-4009-multisocket-race";
      const oracleResult = await raceOneSide(ctx.oraclePort, ctx.fakeUpstream);
      const candidateResult = await raceOneSide(ctx.candidatePort, ctx.fakeUpstream);

      const shapeOf = (response: unknown): string => {
        const envelope = response as { error?: { code?: unknown; message?: unknown } };
        return JSON.stringify(envelope.error ?? null);
      };
      const oracleShapes = oracleResult.loserResponses.map(shapeOf);
      const candidateShapes = candidateResult.loserResponses.map(shapeOf);
      if (JSON.stringify(oracleShapes) !== JSON.stringify(candidateShapes)) {
        return divergent(id, `loser response shapes oracle=${JSON.stringify(oracleShapes)} candidate=${JSON.stringify(candidateShapes)}`, {
          oracleResult,
          candidateResult,
        });
      }
      const expectedError = JSON.stringify({ code: 4009, message: "session busy" });
      if (!oracleShapes.every((shape) => shape === expectedError)) {
        return divergent(id, `expected all 3 losers to get {code:4009,message:"session busy"}, got ${JSON.stringify(oracleShapes)}`);
      }
      if (!oracleResult.winnerCompleted || !candidateResult.winnerCompleted) {
        return divergent(id, "expected the held turn to complete normally on both sides after release", { oracleResult, candidateResult });
      }

      return match(id, { oracleResult, candidateResult });
    },
  },
];
