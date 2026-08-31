// Promotion of E1 item 4 (Evaluator round 1): the four persisted message
// shapes (user / assistant-with-tool_calls / assistant-plain / tool) and
// REST history structurally equal to WS history (L25, assertion 32a).
// Drives one tool-calling turn (which alone produces all four message
// roles: user -> assistant-with-tool_calls -> tool -> assistant-plain
// final reply) then reads the same history back through both the WS RPC
// and the REST route, in insecure mode (no token threading needed --
// --insecure makes every /api route respond without one, per L4).
import { TOOL_CALL_TRIGGERS } from "../fake-upstream.js";
import { sendRawHttpRequest } from "../raw-http-client.js";
import { connectRawWs } from "../raw-ws-client.js";
import { compareMasked, createSessionBoth, divergent, drainUntilComplete, match, type NamedScenario } from "../scenario-helpers.js";

const TRIGGER = "T12_TRIGGER_TERMINAL_SAFE";
if (!(TRIGGER in TOOL_CALL_TRIGGERS)) throw new Error(`${TRIGGER} missing from fake-upstream.ts's TOOL_CALL_TRIGGERS`);

interface MessageShape {
  readonly role: unknown;
  readonly keys: readonly string[];
}

function shapesOf(messages: readonly unknown[]): readonly MessageShape[] {
  return messages.map((message) => {
    const record = message as Record<string, unknown>;
    return { role: record.role, keys: Object.keys(record).sort() };
  });
}

const EXPECTED = {
  user: ["content", "role"],
  assistantTool: ["content", "finish_reason", "role", "tool_calls"],
  assistantPlain: ["content", "finish_reason", "role"],
  tool: ["content", "name", "role", "tool_call_id"],
};

export const PERSISTED_SHAPES_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-persisted-message-shapes-and-rest-equals-ws",
    run: async (ctx) => {
      const id = "t12-persisted-message-shapes-and-rest-equals-ws";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]); // drain gateway.ready

        const created = await createSessionBoth(oracleWs, candidateWs);
        if (created.divergence !== null) return divergent(id, `session.create: ${created.divergence}`, created.evidence);

        oracleWs.sendText(
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: created.oracleSessionId, text: `please ${TRIGGER}` } }),
        );
        candidateWs.sendText(
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompt.submit", params: { session_id: created.candidateSessionId, text: `please ${TRIGGER}` } }),
        );
        await Promise.all([drainUntilComplete(oracleWs, 15, 30_000), drainUntilComplete(candidateWs, 15, 30_000)]);

        oracleWs.sendText(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session.history", params: { session_id: created.oracleSessionId } }));
        candidateWs.sendText(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session.history", params: { session_id: created.candidateSessionId } }));
        const [oracleHistFrame, candidateHistFrame] = await Promise.all([oracleWs.nextFrame(10_000), candidateWs.nextFrame(10_000)]);
        const oracleMessages = (JSON.parse(oracleHistFrame.payload.toString("utf8")) as { result: { messages: unknown[] } }).result.messages;
        const candidateMessages = (JSON.parse(candidateHistFrame.payload.toString("utf8")) as { result: { messages: unknown[] } }).result.messages;

        const oracleShapes = shapesOf(oracleMessages);
        const candidateShapes = shapesOf(candidateMessages);
        const shapeDivergence = compareMasked(oracleShapes, candidateShapes);
        if (shapeDivergence !== null) {
          return divergent(id, `persisted shapes: ${shapeDivergence}`, { oracleShapes, candidateShapes });
        }

        const roles = new Set(oracleShapes.map((shape) => shape.role));
        if (!roles.has("user") || !roles.has("tool")) {
          return divergent(id, "expected at least user and tool roles in the persisted history", { oracleShapes });
        }
        const assistantShapes = oracleShapes.filter((shape) => shape.role === "assistant").map((shape) => shape.keys);
        const hasToolShape = assistantShapes.some((keys) => JSON.stringify(keys) === JSON.stringify(EXPECTED.assistantTool));
        const hasPlainShape = assistantShapes.some((keys) => JSON.stringify(keys) === JSON.stringify(EXPECTED.assistantPlain));
        if (!hasToolShape || !hasPlainShape) {
          return divergent(id, "expected both assistant-with-tool_calls and assistant-plain shapes", { assistantShapes });
        }
        const userShape = oracleShapes.find((shape) => shape.role === "user");
        if (userShape === undefined || JSON.stringify(userShape.keys) !== JSON.stringify(EXPECTED.user)) {
          return divergent(id, "unexpected user message shape", { userShape });
        }
        const toolShape = oracleShapes.find((shape) => shape.role === "tool");
        if (toolShape === undefined || JSON.stringify(toolShape.keys) !== JSON.stringify(EXPECTED.tool)) {
          return divergent(id, "unexpected tool message shape", { toolShape });
        }

        // REST == WS, checked independently on EACH side (not just
        // bilaterally) -- an internal consistency property, not just an
        // oracle/candidate agreement.
        const [oracleRest, candidateRest] = await Promise.all([
          sendRawHttpRequest("127.0.0.1", ctx.oraclePort, {
            method: "GET",
            path: `/api/sessions/${created.oracleSessionId}/messages`,
            headers: [["Host", "127.0.0.1"], ["Connection", "close"]],
          }),
          sendRawHttpRequest("127.0.0.1", ctx.candidatePort, {
            method: "GET",
            path: `/api/sessions/${created.candidateSessionId}/messages`,
            headers: [["Host", "127.0.0.1"], ["Connection", "close"]],
          }),
        ]);
        const oracleRestMessages = (JSON.parse(oracleRest.body.toString("utf8")) as { messages: unknown[] }).messages;
        const candidateRestMessages = (JSON.parse(candidateRest.body.toString("utf8")) as { messages: unknown[] }).messages;
        const oracleRestVsWs = compareMasked(oracleRestMessages, oracleMessages);
        if (oracleRestVsWs !== null) return divergent(id, `oracle REST != WS: ${oracleRestVsWs}`, { oracleRestMessages, oracleMessages });
        const candidateRestVsWs = compareMasked(candidateRestMessages, candidateMessages);
        if (candidateRestVsWs !== null) {
          return divergent(id, `candidate REST != WS: ${candidateRestVsWs}`, { candidateRestMessages, candidateMessages });
        }

        return match(id, { shapes: oracleShapes, restEqualsWs: true });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },
];
