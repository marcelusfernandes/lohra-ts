#!/usr/bin/env node
// Candidate mirror of chat-cold-resume-oracle.py, step for step (contract 47).
// Turn 1: the canned chat dispatches `run_workflow`, the spec parks at a
// checkpoint, and the durable line + cell land under the lease. Turn 2 runs in
// a BRAND NEW node process that only ever sees the rows on disk, answers the
// checkpoint through the public tool, and finishes the run without respawning
// the cell turn 1 already paid for.
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";

import { openStateDatabase } from "../../../../dist/state/index.js";
import { LockRepository } from "../../../../dist/state/locks.js";
import { WorkflowRepository } from "../../../../dist/state/workflow-repository.js";
import {
  ChatCompletionsModel,
  ConversationRuntime,
} from "../../../../dist/conversation/index.js";
import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
} from "../../../../dist/transports/index.js";
import { composeDispatch, RegistryToolDispatcher } from "../../../../dist/tools/index.js";
import { buildSystemPrompt } from "../../../../dist/context/index.js";
import { WorkflowService, workflowToolHandlers } from "../../../../dist/workflow/index.js";

const HOME = process.env.HOME ?? ".";
const DB_PATH = join(HOME, "durable.db");

class Repository {
  sessions = new Map();
  messages = new Map();
  createSession(input) { this.sessions.set(input.id, input); }
  session(id) { return this.sessions.get(id) ?? null; }
  loadMessages(id) { return this.messages.get(id) ?? []; }
  commitTurn(commit) { this.messages.set(commit.sessionId, commit.messages ?? [commit.user, commit.assistant]); }
  commitUsage() {}
  summary() { return null; }
}

class ChildRuntime {
  requests = [];
  installed = new Map();
  /** The durable path REQUIRES this: a runtime without it cannot launch. */
  installLeafSandbox(installation) {
    this.installed.set(installation.fence, installation.wrap((name) => `allowed:${name}`));
    return { dispose: () => { this.installed.delete(installation.fence); } };
  }
  spawn(request) { this.requests.push(request); return `leaf-${String(this.requests.length)}`; }
  collect() {
    return {
      status: "complete",
      output: "leaf-output",
      usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      provider: "stub",
      model: "canned",
    };
  }
  steer() {}
  cancel() {}
}

function durableService(holder, now, child) {
  const connection = openStateDatabase(DB_PATH);
  const service = new WorkflowService({
    runtime: child,
    homeRoot: HOME,
    timerFactory: () => ({ cancel: () => undefined }),
    store: {
      repository: new WorkflowRepository(connection.database),
      locks: new LockRepository(connection.database),
      holder,
      ttl: 900,
      ownershipOf: () => ({ fence: 0, holder, now }),
      database: connection.database,
    },
  });
  return { connection, service };
}

/** Key-sorted, separator-tight JSON: the oracle prints `sort_keys=True`, so the
 * byte comparison is over the same canonical shape on both sides. */
function sorted(value) {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item,
  );
}

function lineOf(connection, runId) {
  const row = new WorkflowRepository(connection.database).getRunState(runId) ?? {};
  return {
    status: row.status ?? null,
    pause_reason: row.pause_reason ?? null,
    has_spec: Boolean(row.spec_json),
  };
}

function cellsOf(connection, runId) {
  const row = connection.database
    .prepare("SELECT count(*) AS n FROM workflow_node_cache WHERE run_id = ?")
    .get(runId);
  return Number(row.n);
}

const resumeIndex = process.argv.indexOf("--resume");
if (resumeIndex >= 0) {
  // Turn 2 — a process that never saw turn 1's engine, only its rows.
  const runId = process.argv[resumeIndex + 1];
  const child = new ChildRuntime();
  const { connection, service } = durableService("resumer", 2, child);
  const handlers = workflowToolHandlers(service);
  const envelope = JSON.parse(
    handlers.run_workflow({ resume_run_id: runId, checkpoint_answers: { gate: "yes" } }),
  );
  const status = await service.status(runId, true);
  process.stdout.write(
    `${sorted({
      resumeAccepted: envelope.status === "started" || envelope.status === "running",
      status: status.status,
      outputs: status.outputs,
      line: lineOf(connection, runId),
      cells: cellsOf(connection, runId),
      leafRequests: child.requests.length,
    })}\n`,
  );
  connection.close();
  process.exit(0);
}

const child = new ChildRuntime();
const { connection, service } = durableService("chat", 1, child);
const dispatch = composeDispatch(
  (name) => Promise.resolve(`{"error":"unexpected ${name}"}`),
  workflowToolHandlers(service),
);
const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "run_workflow",
      description: "Run workflow",
      parameters: { type: "object", properties: { spec: { type: "object" } }, required: ["spec"] },
    },
  },
];
const client = new ChatCompletionsClient({
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "lohra-local",
  transport: new ChatCompletionsTransport(),
  maxRetries: 0,
});
const conversation = new ConversationRuntime({
  repository: new Repository(),
  transport: new ChatCompletionsModel(client),
  promptSnapshot: () =>
    buildSystemPrompt({
      systemMessage: "T16 canned durable workflow chat",
      // Injectable so the harness can prove the delivered artifact is stable
      // across dates; unset in a normal run, where the real date is used.
      ...(process.env.LOHRA_T16_TODAY === undefined ? {} : { today: process.env.LOHRA_T16_TODAY }),
    }).text,
  toolDispatcher: new RegistryToolDispatcher(dispatch),
  toolDefinitions,
  idSource: () => "chat-1",
  clock: () => 1,
  maxIterations: 4,
  maxTokens: 8192,
});

const turn = await conversation.runTurn({
  input: "run the canned workflow",
  provider: "stub",
  model: "stub-coder:1b",
  cwd: process.cwd(),
});
const executed = turn.toolCalls?.[0];
if (executed === undefined) throw new Error("run_workflow was not dispatched");
const started = JSON.parse(executed.result);
const paused = await service.status(started.run_id, true);
const runId = started.run_id;
const turn1 = {
  runId: "<RUN_ID>",
  status: paused.status,
  reason: paused.pause_reason ?? paused.reason ?? null,
  checkpointNode: (paused.checkpoint ?? {}).node_id ?? null,
  line: lineOf(connection, runId),
  cells: cellsOf(connection, runId),
  leafRequests: child.requests.length,
};
await client.close();
connection.close();

// Turn 2 in a NEW process: the run only survives through its durable rows.
const resumed = spawnSync(process.execPath, [resolve(import.meta.filename), "--resume", runId], {
  encoding: "utf8",
  env: process.env,
  maxBuffer: 8 * 1024 * 1024,
});
if (resumed.status !== 0) {
  process.stderr.write(resumed.stderr);
  throw new Error(`resume process failed: ${String(resumed.status)}`);
}
const turn2 = JSON.parse(resumed.stdout.trim().split("\n").at(-1));

process.stdout.write(`${sorted({ turn1, turn2, resumedInNewProcess: true })}\n`);
