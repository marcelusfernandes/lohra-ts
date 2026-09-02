// Promotion of E1 item 7 (Evaluator round 1): a real upstream failure (418
// + a canary substring) rides message.complete.warning, never a separate
// `error` event type -- L21, assertion 53. Reuses the fake upstream's
// content-triggered failure injection (UPSTREAM_FAILURE_NONCE) already
// built for the T11+T12 joint gate.
import { UPSTREAM_FAILURE_NONCE } from "../fake-upstream.js";
import { connectRawWs } from "../raw-ws-client.js";
import {
  compareMasked,
  createSessionBoth,
  divergent,
  drainUntilComplete,
  eventTypeSequence,
  match,
  type NamedScenario,
} from "../scenario-helpers.js";

export const UPSTREAM_ERROR_WARNING_SCENARIOS: readonly NamedScenario[] = [
  {
    id: "t12-upstream-error-warning-field-no-error-event",
    run: async (ctx) => {
      const id = "t12-upstream-error-warning-field-no-error-event";
      const [oracleWs, candidateWs] = await Promise.all([
        connectRawWs("127.0.0.1", ctx.oraclePort, "/api/ws"),
        connectRawWs("127.0.0.1", ctx.candidatePort, "/api/ws"),
      ]);
      try {
        await Promise.all([oracleWs.nextFrame(), candidateWs.nextFrame()]); // drain gateway.ready

        const created = await createSessionBoth(oracleWs, candidateWs);
        if (created.divergence !== null)
          return divergent(id, `session.create: ${created.divergence}`, created.evidence);

        const text = `please fail with ${UPSTREAM_FAILURE_NONCE}`;
        oracleWs.sendText(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "prompt.submit",
            params: { session_id: created.oracleSessionId, text },
          }),
        );
        candidateWs.sendText(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "prompt.submit",
            params: { session_id: created.candidateSessionId, text },
          }),
        );

        const [oracleEvents, candidateEvents] = await Promise.all([
          drainUntilComplete(oracleWs),
          drainUntilComplete(candidateWs),
        ]);
        const oracleSequence = eventTypeSequence(oracleEvents);
        const candidateSequence = eventTypeSequence(candidateEvents);
        if (JSON.stringify(oracleSequence) !== JSON.stringify(candidateSequence)) {
          return divergent(
            id,
            `event sequence oracle=${JSON.stringify(oracleSequence)} candidate=${JSON.stringify(candidateSequence)}`,
            {
              oracleEvents,
              candidateEvents,
            },
          );
        }
        if (oracleSequence.includes("error")) {
          return divergent(id, "expected no separate error event, both sides emitted one", {
            oracleSequence,
          });
        }

        const oracleComplete = oracleEvents.find((event) => event.type === "message.complete");
        const candidateComplete = candidateEvents.find(
          (event) => event.type === "message.complete",
        );
        const completeDivergence = compareMasked(
          oracleComplete?.payload,
          candidateComplete?.payload,
        );
        if (completeDivergence !== null) {
          return divergent(id, `message.complete payload: ${completeDivergence}`, {
            oracleComplete,
            candidateComplete,
          });
        }

        const payload = oracleComplete?.payload as
          { status?: string; warning?: string; text?: string } | undefined;
        if (
          payload?.status !== "error" ||
          !(payload.warning ?? "").includes("418") ||
          !(payload.warning ?? "").includes(UPSTREAM_FAILURE_NONCE)
        ) {
          return divergent(id, "message.complete did not carry the expected error/warning shape", {
            payload,
          });
        }

        return match(id, { eventSequence: oracleSequence, messageComplete: payload });
      } finally {
        oracleWs.close();
        candidateWs.close();
      }
    },
  },
];
