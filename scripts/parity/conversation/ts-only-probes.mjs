#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import {
  ConversationCancelledError,
  ConversationRuntime,
  MaxIterationsError,
  UnexpectedToolCallError,
} from "../../../dist/conversation/index.js";
import { pythonJsonDumps } from "../../../dist/serialization/python-json.js";

const output = resolve(".probe-evidence/t08");
mkdirSync(output, { recursive: true });
const selected = process.argv[2];
let suiteFailures = 0;

function persist(id, observable, expected) {
  const failures = isDeepStrictEqual(observable, expected)
    ? []
    : [{ code: "PROBE_EXPECTATION", expected, actual: observable }];
  const projection = pythonJsonDumps(observable);
  const evidence = {
    schemaVersion: 1,
    scenario: id,
    comparisonClass: "intentional-ts-only",
    observable,
    expected,
    failures,
    verdict: failures.length === 0 ? "match" : "divergent",
    projectionSha256: createHash("sha256").update(projection).digest("hex"),
  };
  const path = join(output, `${id}.json`);
  const body = `${pythonJsonDumps(evidence)}\n`;
  if (!existsSync(path) || readFileSync(path, "utf8") !== body) writeFileSync(path, body);
  process.stdout.write(`${id} ${evidence.verdict} ${evidence.projectionSha256}\n`);
  if (failures.length > 0) suiteFailures += 1;
}

async function guarded(id, action) {
  if (selected !== undefined && selected !== id) return;
  try {
    const { observable, expected } = await action();
    persist(id, observable, expected);
  } catch (error) {
    const observable = {
      cause: error instanceof Error ? `${error.name}:${error.message}` : String(error),
    };
    const expected = { cause: null };
    persist(id, observable, expected);
  }
}

class Repository {
  sessions = new Map();
  messages = new Map();
  turns = [];
  usages = [];

  createSession(input) {
    this.sessions.set(input.id, globalThis.structuredClone(input));
  }
  session(id) {
    return globalThis.structuredClone(this.sessions.get(id) ?? null);
  }
  loadMessages(id) {
    return globalThis.structuredClone(this.messages.get(id) ?? []);
  }
  commitTurn(commit) {
    this.turns.push(globalThis.structuredClone(commit));
    this.messages.set(commit.sessionId, [
      ...(this.messages.get(commit.sessionId) ?? []),
      globalThis.structuredClone(commit.user),
      globalThis.structuredClone(commit.assistant),
    ]);
  }
  commitUsage(commit) {
    this.usages.push(globalThis.structuredClone(commit));
  }
  summary(id) {
    const turns = this.turns.filter((entry) => entry.sessionId === id);
    return {
      inputTokens: turns.reduce((sum, entry) => sum + (entry.usage?.inputTokens ?? 0), 0),
      outputTokens: turns.reduce((sum, entry) => sum + (entry.usage?.outputTokens ?? 0), 0),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiCallCount: turns.length,
      pricedCallCount: turns.length,
      actualCostUsd: 0,
      estimatedCostUsd: 0,
    };
  }
}

const usage = Object.freeze({
  inputTokens: 11,
  outputTokens: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});
const textResponse = () => ({
  content: "ok",
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage,
  providerData: null,
});
const toolResponse = (name = "read_file") => ({
  content: null,
  finishReason: "tool_calls",
  toolCalls: [{ id: "c1", name, arguments: "{}", providerData: null }],
  reasoning: null,
  usage,
  providerData: null,
});

await guarded("t08-prompt-snapshot-once", async () => {
  const repository = new Repository();
  const systems = [];
  let source = "prompt-v1";
  let factoryCalls = 0;
  let closes = 0;
  const transport = {
    complete(request) {
      systems.push(request.system);
      return Promise.resolve(textResponse());
    },
    close() {
      closes += 1;
    },
  };
  const runtime = new ConversationRuntime({
    repository,
    transport,
    promptSnapshot: () => {
      factoryCalls += 1;
      return source;
    },
    idSource: () => "s",
    clock: () => 1,
  });
  await runtime.runTurn({ input: "one", provider: "ollama", model: "m", cwd: "/tmp" });
  source = "prompt-v2";
  await runtime.runTurn({
    input: "two",
    provider: "ollama",
    model: "m",
    cwd: "/tmp",
    sessionId: "s",
  });
  return {
    observable: {
      factoryCalls,
      systems,
      stored: repository.session("s")?.systemPrompt,
      closes,
    },
    expected: {
      factoryCalls: 1,
      systems: ["prompt-v1", "prompt-v1"],
      stored: "prompt-v1",
      closes: 2,
    },
  };
});

await guarded("t08-max-iterations", async () => {
  const repository = new Repository();
  let dispatched = 0;
  let closes = 0;
  let calls = 0;
  let thrown = null;
  const runtime = new ConversationRuntime({
    repository,
    transport: {
      complete: () => {
        calls += 1;
        if (calls > 3) throw new Error("PROBE_UNBOUNDED");
        return Promise.resolve(toolResponse());
      },
      close: () => {
        closes += 1;
      },
    },
    promptSnapshot: () => "p",
    toolDispatcher: {
      dispatch: () => {
        dispatched += 1;
        return Promise.resolve({ role: "tool", content: "ok" });
      },
    },
    idSource: () => "s",
    clock: () => 1,
    maxIterations: 1,
  });
  try {
    await runtime.runTurn({ input: "x", provider: "ollama", model: "m", cwd: "/tmp" });
  } catch (error) {
    if (error instanceof MaxIterationsError) thrown = `${error.name}:${error.code}`;
    else throw error;
  }
  return {
    observable: {
      thrown,
      dispatched,
      turnCommits: repository.turns.length,
      usageCommits: repository.usages.length,
      closes,
    },
    expected: {
      thrown: "MaxIterationsError:MAX_ITERATIONS",
      dispatched: 0,
      turnCommits: 0,
      usageCommits: 0,
      closes: 1,
    },
  };
});

await guarded("t08-cancel-cleanup", async () => {
  const repository = new Repository();
  const controller = new globalThis.AbortController();
  const events = [];
  let observedSignal = false;
  let closes = 0;
  let pending = false;
  let thrown = null;
  const transport = {
    complete({ signal }) {
      pending = true;
      return new Promise((_, reject) => {
        const timeout = globalThis.setTimeout(() => {
          pending = false;
          reject(new Error("PROBE_CANCEL_NOT_OBSERVED"));
        }, 250);
        signal.addEventListener(
          "abort",
          () => {
            globalThis.clearTimeout(timeout);
            observedSignal = true;
            pending = false;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    close() {
      closes += 1;
    },
  };
  const runtime = new ConversationRuntime({
    repository,
    transport,
    promptSnapshot: () => "p",
    eventSink: (event) => events.push(event.type),
    idSource: () => "s",
    clock: () => 1,
  });
  const turn = runtime.runTurn({
    input: "x",
    provider: "ollama",
    model: "m",
    cwd: "/tmp",
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort(new Error("probe cancel"));
  try {
    await turn;
  } catch (error) {
    if (error instanceof ConversationCancelledError) thrown = `${error.name}:${error.code}`;
    else throw error;
  }
  return {
    observable: {
      thrown,
      observedSignal,
      closes,
      pending,
      turnCommits: repository.turns.length,
      usageCommits: repository.usages.length,
      failedEvent: events.at(-1),
    },
    expected: {
      thrown: "ConversationCancelledError:CONVERSATION_CANCELLED",
      observedSignal: true,
      closes: 1,
      pending: false,
      turnCommits: 0,
      usageCommits: 0,
      failedEvent: "turn.failed",
    },
  };
});

await guarded("t08-unexpected-tool-call", async () => {
  const outcomes = [];
  for (const name of ["read_file", "no_such_tool_xyz"]) {
    const repository = new Repository();
    let dispatched = 0;
    let thrown = null;
    const runtime = new ConversationRuntime({
      repository,
      transport: { complete: () => Promise.resolve(toolResponse(name)), close: () => {} },
      promptSnapshot: () => "p",
      toolDispatcher: undefined,
      idSource: () => name,
      clock: () => 1,
    });
    try {
      await runtime.runTurn({ input: "x", provider: "ollama", model: "m", cwd: "/tmp" });
    } catch (error) {
      if (error instanceof UnexpectedToolCallError)
        thrown = `${error.name}:${error.code}:${error.message}`;
      else throw error;
    }
    outcomes.push({
      name,
      thrown,
      dispatched,
      turnCommits: repository.turns.length,
      usageCommits: repository.usages.length,
    });
  }
  const expectedOutcome = (name) => ({
    name,
    thrown:
      "UnexpectedToolCallError:UNEXPECTED_TOOL_CALL:provider returned tool_calls while tools are disabled",
    dispatched: 0,
    turnCommits: 0,
    usageCommits: 0,
  });
  return {
    observable: { outcomes },
    expected: { outcomes: [expectedOutcome("read_file"), expectedOutcome("no_such_tool_xyz")] },
  };
});

if (
  selected !== undefined &&
  ![
    "t08-prompt-snapshot-once",
    "t08-max-iterations",
    "t08-cancel-cleanup",
    "t08-unexpected-tool-call",
  ].includes(selected)
) {
  process.stderr.write(`unknown probe: ${selected}\n`);
  process.exitCode = 2;
} else if (suiteFailures > 0) {
  process.exitCode = 1;
}
