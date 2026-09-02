// Promotion of E1 item 9 (Evaluator round 1): real terminal RCE (a safe
// command genuinely executes, stdout proves it), the dangerous-command
// deny with the EXACT oracle string, and memory reaching MemoryTool.handle
// rather than being auto-denied (assertions 38-41). Three separate
// sessions, one triggered tool call each, checking tool.complete's
// `result` (itself a JSON string -- see tool-event-payload.ts -- so it's
// parsed, not compared as raw text; the L8 golden scenario already covers
// the string-serialization property on its own).
import { TOOL_CALL_TRIGGERS } from "../fake-upstream.js";
import { connectRawWs, type RawWsClient } from "../raw-ws-client.js";
import {
  compareMasked,
  createSessionBoth,
  divergent,
  drainUntilComplete,
  match,
  type NamedScenario,
} from "../scenario-helpers.js";

const TRIGGERS = {
  safe: "T12_TRIGGER_TERMINAL_SAFE",
  danger: "T12_TRIGGER_TERMINAL_DANGER",
  memory: "T12_TRIGGER_MEMORY_LIST",
} as const;
for (const trigger of Object.values(TRIGGERS)) {
  if (!(trigger in TOOL_CALL_TRIGGERS))
    throw new Error(`${trigger} missing from fake-upstream.ts's TOOL_CALL_TRIGGERS`);
}

async function driveOneToolTurn(
  oracleWs: RawWsClient,
  candidateWs: RawWsClient,
  trigger: string,
  rpcId: number,
): Promise<{ readonly oracleResult: unknown; readonly candidateResult: unknown }> {
  const created = await createSessionBoth(oracleWs, candidateWs);
  if (created.divergence !== null)
    throw new Error(`session.create diverged: ${created.divergence}`);

  oracleWs.sendText(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "prompt.submit",
      params: { session_id: created.oracleSessionId, text: `please ${trigger}` },
    }),
  );
  candidateWs.sendText(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "prompt.submit",
      params: { session_id: created.candidateSessionId, text: `please ${trigger}` },
    }),
  );
  const [oracleEvents, candidateEvents] = await Promise.all([
    drainUntilComplete(oracleWs, 15, 30_000),
    drainUntilComplete(candidateWs, 15, 30_000),
  ]);
  const oracleComplete = oracleEvents.find((event) => event.type === "tool.complete");
  const candidateComplete = candidateEvents.find((event) => event.type === "tool.complete");
  const oracleResultString = (oracleComplete?.payload as { result?: string } | undefined)?.result;
  const candidateResultString = (candidateComplete?.payload as { result?: string } | undefined)
    ?.result;
  const oracleResult =
    oracleResultString === undefined ? null : (JSON.parse(oracleResultString) as unknown);
  const candidateResult =
    candidateResultString === undefined ? null : (JSON.parse(candidateResultString) as unknown);
  return { oracleResult, candidateResult };
}

export const RCE_DENY_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-tool-terminal-rce-proof-and-dangerous-deny",
    run: async (ctx) => {
      const id = "t12-tool-terminal-rce-proof-and-dangerous-deny";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]); // drain gateway.ready

        const safe = await driveOneToolTurn(oracleWs, candidateWs, TRIGGERS.safe, 2);
        const safeDivergence = compareMasked(safe.oracleResult, safe.candidateResult);
        if (safeDivergence !== null)
          return divergent(id, `terminal safe result: ${safeDivergence}`, safe);
        const safeResult = safe.oracleResult as {
          ok?: boolean;
          exit_code?: number;
          stdout?: string;
        };
        if (
          safeResult.ok !== true ||
          safeResult.exit_code !== 0 ||
          safeResult.stdout !== "T12_TERMINAL_CANARY\n"
        ) {
          return divergent(id, "terminal safe command did not genuinely execute", { safeResult });
        }

        const danger = await driveOneToolTurn(oracleWs, candidateWs, TRIGGERS.danger, 3);
        const dangerDivergence = compareMasked(danger.oracleResult, danger.candidateResult);
        if (dangerDivergence !== null)
          return divergent(id, `terminal danger result: ${dangerDivergence}`, danger);
        const dangerResult = danger.oracleResult as { error?: string; command?: string };
        if (
          dangerResult.error !== "command was not approved by the user" ||
          !(dangerResult.command ?? "").includes("rm -rf")
        ) {
          return divergent(id, "dangerous command was not denied with the exact oracle string", {
            dangerResult,
          });
        }

        return match(id, { safeResult, dangerResult });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },
  {
    id: "t12-tool-memory-reaches-handler-no-autodeny",
    run: async (ctx) => {
      const id = "t12-tool-memory-reaches-handler-no-autodeny";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]); // drain gateway.ready
        const mem = await driveOneToolTurn(oracleWs, candidateWs, TRIGGERS.memory, 2);
        const memDivergence = compareMasked(mem.oracleResult, mem.candidateResult);
        if (memDivergence !== null) return divergent(id, `memory result: ${memDivergence}`, mem);
        const memResult = mem.oracleResult as { error?: string };
        if (memResult.error !== "unknown action 'list' (use add/replace/remove)") {
          return divergent(
            id,
            "memory action:list did not reach MemoryTool.handle with the exact oracle error",
            { memResult },
          );
        }
        return match(id, { memResult });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },
];
