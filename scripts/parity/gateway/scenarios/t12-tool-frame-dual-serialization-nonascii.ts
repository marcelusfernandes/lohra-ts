// Promotion of E1 item 1 (Evaluator round 1), highest regression risk: the
// dual-serialization golden (L8, assertions 37/39). args_text (a JSON
// string EMBEDDED as a string field) must be spaced and escaped -- Python
// json.dumps defaults -- while the OUTER envelope stays compact and
// literal. This is invisible to any comparison that goes through
// JSON.parse first (parsing erases whitespace/escaping), so this scenario
// works off the RAW frame text, not drainUntilComplete's already-parsed
// events.
import { TOOL_CALL_TRIGGERS } from "../fake-upstream.js";
import { connectRawWs, WS_OPCODE, type RawWsClient } from "../raw-ws-client.js";
import { createSessionBoth, divergent, match, type NamedScenario } from "../scenario-helpers.js";

const TRIGGER = "T12_TRIGGER_READ_FILE_NONASCII";
if (!(TRIGGER in TOOL_CALL_TRIGGERS))
  throw new Error(`${TRIGGER} missing from fake-upstream.ts's TOOL_CALL_TRIGGERS`);

interface RawTurnFrames {
  readonly toolStartRaw: string | null;
  readonly toolCompleteRaw: string | null;
}

async function driveTriggeredTurn(
  ws: RawWsClient,
  sessionId: string,
  rpcId: number,
): Promise<RawTurnFrames> {
  ws.sendText(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "prompt.submit",
      params: { session_id: sessionId, text: `please ${TRIGGER}` },
    }),
  );
  let toolStartRaw: string | null = null;
  let toolCompleteRaw: string | null = null;
  for (let i = 0; i < 15; i += 1) {
    const frame = await ws.nextFrame(30_000);
    if (frame.opcode !== WS_OPCODE.text) continue;
    const text = frame.payload.toString("utf8");
    if (text.includes('"tool.start"') && toolStartRaw === null) toolStartRaw = text;
    if (text.includes('"tool.complete"') && toolCompleteRaw === null) toolCompleteRaw = text;
    if (text.includes('"message.complete"')) break;
  }
  return { toolStartRaw, toolCompleteRaw };
}

function extractArgsText(toolStartRaw: string): string | null {
  const envelope = JSON.parse(toolStartRaw) as { params?: { payload?: { args_text?: unknown } } };
  const value = envelope.params?.payload?.args_text;
  return typeof value === "string" ? value : null;
}

export const DUAL_SERIALIZATION_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-tool-frame-dual-serialization-nonascii",
    run: async (ctx) => {
      const id = "t12-tool-frame-dual-serialization-nonascii";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]); // drain gateway.ready

        const created = await createSessionBoth(oracleWs, candidateWs);
        if (created.divergence !== null)
          return divergent(id, `session.create: ${created.divergence}`, created.evidence);

        const [oracleFrames, candidateFrames] = await Promise.all([
          driveTriggeredTurn(oracleWs, created.oracleSessionId, 2),
          driveTriggeredTurn(candidateWs, created.candidateSessionId, 2),
        ]);

        if (oracleFrames.toolStartRaw === null || candidateFrames.toolStartRaw === null) {
          return divergent(id, "tool.start not observed on both sides", oracleFrames);
        }

        // Bilateral, byte-exact: the args_text VALUE itself carries the
        // spacing/escaping (they're literal characters inside the
        // string), so comparing the extracted string is exactly
        // comparing the serialization, not just the parsed structure.
        const oracleArgsText = extractArgsText(oracleFrames.toolStartRaw);
        const candidateArgsText = extractArgsText(candidateFrames.toolStartRaw);
        if (oracleArgsText !== candidateArgsText) {
          return divergent(
            id,
            `args_text oracle=${JSON.stringify(oracleArgsText)} candidate=${JSON.stringify(candidateArgsText)}`,
            {
              oracleFrames,
              candidateFrames,
            },
          );
        }
        if (oracleArgsText === null) return divergent(id, "args_text missing on both sides");

        // Defense-in-depth: the two serializer properties the golden
        // fixes (this project's own tests/gateway/tool-event-payload.test.ts
        // already proves these for the candidate in isolation; this
        // confirms them bilaterally, over the real wire, against the
        // real oracle).
        if (!oracleArgsText.includes('": "')) {
          return divergent(id, "args_text is not spaced (missing '\": \"')", { oracleArgsText });
        }
        if (!oracleArgsText.includes("\\u00e3")) {
          return divergent(id, "args_text does not escape non-ASCII (missing \\u00e3)", {
            oracleArgsText,
          });
        }
        const outerCompact =
          oracleFrames.toolStartRaw.includes('","') || oracleFrames.toolStartRaw.includes('":"');
        if (!outerCompact) {
          return divergent(id, "outer tool.start frame is not compact", {
            toolStartRaw: oracleFrames.toolStartRaw,
          });
        }

        if (oracleFrames.toolCompleteRaw === null || candidateFrames.toolCompleteRaw === null) {
          return divergent(id, "tool.complete not observed on both sides", {
            oracleFrames,
            candidateFrames,
          });
        }
        const oracleCompleteHasLiteral = oracleFrames.toolCompleteRaw.includes("ção");
        const candidateCompleteHasLiteral = candidateFrames.toolCompleteRaw.includes("ção");
        if (oracleCompleteHasLiteral !== candidateCompleteHasLiteral || !oracleCompleteHasLiteral) {
          return divergent(
            id,
            "tool.complete does not carry literal non-ASCII in args on both sides",
            {
              oracleCompleteHasLiteral,
              candidateCompleteHasLiteral,
            },
          );
        }

        return match(id, {
          argsText: oracleArgsText,
          outerCompact,
          toolCompleteHasLiteralNonAscii: true,
        });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },
];
