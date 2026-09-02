#!/usr/bin/env node
// P2/P3 — a WRITER process presenting a planted token against a live owner
// held by another OS process. Every write category is attempted; a guard that
// lost a conjunct lets one of them land and the orchestrator turns red.
//
//   usage: planted-writer.mjs <db> <runId> <phase> <fence> <holder> <now>
import process from "node:process";

import { openStateDatabase } from "../../../../dist/state/index.js";
import { WorkflowRepository } from "../../../../dist/state/workflow-repository.js";

const [db, runId, phase, fence, holder, now] = process.argv.slice(2);
if (db === undefined || runId === undefined || phase === undefined) {
  throw new Error("usage: planted-writer.mjs <db> <runId> <phase> <fence> <holder> <now>");
}

const connection = openStateDatabase(db);
const repository = new WorkflowRepository(connection.database);
const ownership = { fence: Number(fence), holder, now: Number(now) };
const key = `${phase}-${String(process.pid)}`;

const attempts = [
  {
    category: "state",
    run: () =>
      repository.putRunState(runId, {
        name: "planted", owner: holder, status: key, pauseReason: null,
        pausePayloadJson: null, specJson: "{}", argsJson: "{}", tokenBudget: null,
        tainted: false, progressJson: null, auditSegmentId: null,
        updatedAt: ownership.now, fence: ownership.fence, holder, now: ownership.now,
      }),
    landed: () => (repository.getRunState(runId) ?? {}).status === key,
  },
  {
    category: "cache",
    run: () => repository.putCacheCell(runId, key, "node", "{}", "complete", ownership),
    landed: () => repository.getCacheCell(runId, key) !== null,
  },
  {
    category: "node-cost",
    run: () => repository.putCacheCost(runId, key, 1, 1, 0, 0, 0, ownership),
    landed: () => repository.getCacheCost(runId, key) !== null,
  },
  {
    category: "spend",
    run: () => repository.putRunSpend(runId, 10, 1, 1, 0, 0, 0, ownership),
    landed: () => Number((repository.getRunSpend(runId) ?? {}).token_budget) === 10,
  },
  {
    category: "combined",
    run: () =>
      repository.putCacheCellWithCost(runId, `${key}-c`, "node", "{}", "complete", ownership, {
        tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      }),
    landed: () =>
      repository.getCacheCell(runId, `${key}-c`) !== null ||
      repository.getCacheCost(runId, `${key}-c`) !== null,
  },
];

const outcomes = attempts.map((attempt) => ({
  category: attempt.category,
  refused: attempt.run() === false,
  landed: attempt.landed(),
}));
connection.close();

process.stdout.write(
  `${JSON.stringify({
    phase,
    pid: process.pid,
    attempts: outcomes.length,
    refusals: outcomes.filter((outcome) => outcome.refused).length,
    landed: outcomes.filter((outcome) => outcome.landed).map((outcome) => outcome.category),
    outcomes,
  })}\n`,
);
