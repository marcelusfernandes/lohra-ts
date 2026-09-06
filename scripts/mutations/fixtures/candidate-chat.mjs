import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { ChatCompletionsModel, ConversationRuntime } from "../../../dist/conversation/index.js";
import { ChatCompletionsClient, ChatCompletionsTransport } from "../../../dist/transports/index.js";
import { composeDispatch, RegistryToolDispatcher } from "../../../dist/tools/index.js";
import { buildSystemPrompt } from "../../../dist/context/index.js";
import { WorkflowService, workflowToolHandlers } from "../../../dist/workflow/index.js";

class Repository {
  sessions = new Map();
  messages = new Map();
  createSession(input) {
    this.sessions.set(input.id, input);
  }
  session(id) {
    return this.sessions.get(id) ?? null;
  }
  loadMessages(id) {
    return this.messages.get(id) ?? [];
  }
  commitTurn(commit) {
    this.messages.set(commit.sessionId, commit.messages ?? [commit.user, commit.assistant]);
  }
  commitUsage() {}
  summary() {
    return null;
  }
}

class ChildRuntime {
  requests = [];
  spawn(request) {
    this.requests.push(request);
    return `leaf-${String(this.requests.length)}`;
  }
  collect() {
    return {
      status: "complete",
      output: "leaf-output",
      usage: {
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      provider: "stub",
      model: "canned",
    };
  }
  steer() {}
  cancel() {}
}

const child = new ChildRuntime();
const service = new WorkflowService({ runtime: child, idSource: () => "run-1" });
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
const runtime = new ConversationRuntime({
  repository: new Repository(),
  transport: new ChatCompletionsModel(client),
  promptSnapshot: () => buildSystemPrompt({ systemMessage: "T15 canned workflow chat" }).text,
  toolDispatcher: new RegistryToolDispatcher(dispatch),
  toolDefinitions,
  idSource: () => "chat-1",
  clock: () => 1,
  maxIterations: 4,
  maxTokens: 8192,
});

const turn = await runtime.runTurn({
  input: "run the canned workflow",
  provider: "stub",
  model: "stub-coder:1b",
  cwd: process.cwd(),
});
const executed = turn.toolCalls?.[0];
if (executed === undefined) throw new Error("run_workflow was not dispatched");
const started = JSON.parse(executed.result);
const status = await service.status(started.run_id, true);

const requestPath = resolve(process.env.LOHRA_PARITY_PROFILE ?? ".", "stub-requests.jsonl");
const requestBodies = readFileSync(requestPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line).body);
const requests = requestBodies.map((body) => ({
  model: body.model,
  maxTokens: body.max_tokens,
  roles: body.messages.map((message) => message.role),
  hasRunWorkflow: body.tools?.some((entry) => entry.function?.name === "run_workflow") ?? false,
}));

const projection = {
  final: turn.response.content,
  apiCalls: turn.apiCalls,
  tool: {
    name: executed.name,
    args: JSON.parse(executed.arguments),
    started: {
      ok: started.ok,
      run_id: "<RUN_ID>",
      accepted: started.status === "started" || started.status === "running",
    },
  },
  run: {
    run_id: "<RUN_ID>",
    status: status.status,
    outputs: status.outputs,
    faults: status.faults,
    null_count: status.null_count,
    engine_faults: status.engine_faults,
    cap_trips: status.cap_trips,
    validation_retries: status.validation_retries,
    tokens: [
      status.tokens_in,
      status.tokens_out,
      status.cache_read_tokens,
      status.cache_write_tokens,
      status.reasoning_tokens,
    ],
  },
  leafRequests: child.requests.map((request) => ({
    prompt: request.prompt,
    role: request.causalContext.role,
  })),
  requests,
};
await client.close();
process.stdout.write(`${JSON.stringify(projection)}\n`);
