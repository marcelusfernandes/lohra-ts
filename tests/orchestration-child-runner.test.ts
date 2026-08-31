import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClientPool } from "../src/agent/client-pool.js";
import { getProviderProfile, registerProvider } from "../src/providers/index.js";
import { openStateDatabase, SessionRepository } from "../src/state/index.js";
import type { ToolDefinition } from "../src/tools/index.js";
import {
  ChatCompletionsClient,
  ChatCompletionsTransport,
  type ChatHttpPort,
  type ChatHttpRequest,
  type HttpResponseData,
} from "../src/transports/index.js";
import { createChildRunner } from "../src/orchestration/child-runner.js";
import type { SpawnConfig } from "../src/orchestration/core.js";

const encoder = new TextEncoder();
// Never aborted — these tests exercise turn behavior, not cancellation;
// shutdown()'s cancellation wiring is covered separately.
const noSignal = new AbortController().signal;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponseData {
  return {
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body: encoder.encode(JSON.stringify(body)),
  };
}

// contract L2: children always stream, so every success fixture here has to
// speak ChatCompletionsClient.stream()'s SSE framing, not the plain-JSON
// create() shape — a fake this test previously used and that silently never
// exercised the streaming path createChildRunner actually calls.
function sseResponse(frames: readonly unknown[]): HttpResponseData {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: encoder.encode(body),
  };
}

function assistantStream(text: string, promptTokens = 11, completionTokens = 4): HttpResponseData {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } },
  ]);
}

function toolCallStream(name: string, args: string, callId: string): HttpResponseData {
  return sseResponse([
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: callId, function: { name, arguments: args } }] },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ]);
}

class QueuePort implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  constructor(private readonly queue: Array<HttpResponseData | Error>) {}
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.requests.push(request);
    const value = this.queue.shift();
    if (value instanceof Error) return Promise.reject(value);
    if (value === undefined) return Promise.reject(new Error("queue exhausted"));
    return Promise.resolve(value);
  }
}

function fakeClient(queue: Array<HttpResponseData | Error>): { client: ChatCompletionsClient; port: QueuePort } {
  const port = new QueuePort(queue);
  const client = new ChatCompletionsClient({
    baseUrl: "http://parent.invalid/v1",
    apiKey: "lohra-local",
    transport: new ChatCompletionsTransport(),
    http: port,
  });
  return { client, port };
}

const roots: string[] = [];

function setup(): { readonly sessions: SessionRepository; readonly close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lohra-child-runner-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  return {
    sessions: new SessionRepository(connection.database, () => 1000, connection.ftsEnabled),
    close: () => {
      connection.close();
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const parentTools: readonly ToolDefinition[] = [
  { type: "function", function: { name: "read_file", description: "", parameters: {} } },
  { type: "function", function: { name: "spawn_session", description: "", parameters: {} } },
];

function makeRunner(
  sessions: SessionRepository,
  clientPool: ClientPool,
  overrides: Partial<Parameters<typeof createChildRunner>[0]> = {},
) {
  return createChildRunner({
    sessions,
    parentSessionId: "parent-1",
    clientPool,
    baseDispatch: () => Promise.resolve("should not be called"),
    parentToolDefinitions: parentTools,
    defaultModel: "fake-model-a",
    cwd: "/tmp",
    idSource: () => "unused",
    clock: () => 1000,
    childMaxIterations: 50,
    ...overrides,
  });
}

describe("createChildRunner", () => {
  it("runs a turn via ClientPool's parent client, freezing systemPrompt and filtering tools to the child allow-list", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai") ?? (() => {
      throw new Error("openai profile missing");
    })();
    const { client, port } = fakeClient([assistantStream("hi from child")]);
    const pool = new ClientPool(parentProfile, client, {
      home: "/tmp",
      environment: {},
    });
    const runner = makeRunner(sessions, pool);

    const config: SpawnConfig = { prompt: "do the thing" };
    const result = await runner("child-1", config, "FROZEN SYSTEM PROMPT", () => [], noSignal);

    expect(result.status).toBe("complete");
    expect(result.output).toBe("hi from child");
    expect(result.provider).toBe(parentProfile.name);
    expect(result.model).toBe("fake-model-a");
    expect(result.tokensIn).toBe(11);
    expect(result.tokensOut).toBe(4);

    expect(port.requests).toHaveLength(1);
    const body = JSON.parse(port.requests[0]?.body ?? "null") as {
      messages: readonly { role: string; content: string }[];
      tools: readonly { function: { name: string } }[];
    };
    expect(body.messages[0]).toEqual({ role: "system", content: "FROZEN SYSTEM PROMPT" });
    expect(body.tools.map((t) => t.function.name)).toEqual(["read_file"]);

    const row = sessions.getSession("child-1") as Readonly<Record<string, unknown>>;
    expect(row.source).toBe("orchestration");
    expect(row.parent_session_id).toBe("parent-1");
    close();
  });

  it("resolves an overridden provider/model via ClientPool, leaving the parent client untouched (L1)", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const parent = fakeClient([assistantStream("parent should not answer")]);
    const altProfile = {
      ...parentProfile,
      name: "zchildrunneralt",
      aliases: [],
      fallbackModels: ["alt-model-1"],
      requiresApiKey: false,
    };
    registerProvider(altProfile);
    const alt = fakeClient([assistantStream("hi from alt provider")]);
    const pool = new ClientPool(parentProfile, parent.client, {
      home: "/tmp",
      environment: {},
      build: () => alt.client,
    });
    const runner = makeRunner(sessions, pool);

    const config: SpawnConfig = { prompt: "do the thing", provider: "zchildrunneralt" };
    const result = await runner("child-2", config, "SYS", () => [], noSignal);

    expect(result.status).toBe("complete");
    expect(result.output).toBe("hi from alt provider");
    expect(result.provider).toBe("zchildrunneralt");
    expect(result.model).toBe("alt-model-1");
    expect(parent.port.requests).toHaveLength(0);
    expect(alt.port.requests).toHaveLength(1);
    close();
  });

  it("maps MaxIterationsError to status:'error' with the child's own leash, ignoring env (L10)", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const toolCall = (): HttpResponseData => toolCallStream("read_file", '{"path":"x"}', "call_1");
    const { client, port } = fakeClient([toolCall(), toolCall()]);
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const baseDispatch = (): Promise<string> => Promise.resolve(JSON.stringify({ ok: true, result: "x" }));
    const runner = makeRunner(sessions, pool, { childMaxIterations: 2, baseDispatch });

    const result = await runner("child-3", { prompt: "loop forever" }, "SYS", () => [], noSignal);

    expect(result.status).toBe("error");
    expect(result.output).toContain("max_iterations (2)");
    expect(port.requests).toHaveLength(2);
    // MaxIterationsError carries the cumulative usage across both iterations
    // (5+5 in, 2+2 out) — the generic catch-all path (no usage on the thrown
    // error) would report 0/0 here, so this is what actually distinguishes
    // the dedicated branch from falling through to the generic one.
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(4);
    close();
  });

  it("classifies a 429 upstream failure as quota_exhausted with retry_after from the header (L15)", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const { client } = fakeClient([
      jsonResponse(429, { error: "rate limited" }, { "retry-after": "30" }),
    ]);
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runner = makeRunner(sessions, pool);

    const result = await runner("child-4", { prompt: "hi" }, "SYS", () => [], noSignal);

    expect(result.status).toBe("error");
    expect(result.errorKind).toBe("quota_exhausted");
    expect(result.retryAfter).toBe(30);
    close();
  });

  it("maps a 500 upstream failure to error_kind:null (L15 boundary)", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const { client } = fakeClient([jsonResponse(500, { error: "boom" })]);
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runner = makeRunner(sessions, pool);

    const result = await runner("child-5", { prompt: "hi" }, "SYS", () => [], noSignal);

    expect(result.status).toBe("error");
    expect(result.errorKind).toBeNull();
    expect(result.retryAfter).toBeNull();
    close();
  });

  it("resolves (never rejects) when the per-task provider override is unknown — required so delegate_task's Promise.all can't be broken by one bad task (L17)", async () => {
    const { sessions, close } = setup();
    sessions.createSession({ id: "parent-1", source: "gateway" });
    const parentProfile = getProviderProfile("openai");
    if (parentProfile === null) throw new Error("openai profile missing");
    const { client, port } = fakeClient([]);
    const pool = new ClientPool(parentProfile, client, { home: "/tmp", environment: {} });
    const runner = makeRunner(sessions, pool);

    const result = await runner(
      "child-6",
      { prompt: "hi", provider: "zz-does-not-exist" },
      "SYS",
      () => [],
      noSignal,
    );

    expect(result.status).toBe("error");
    expect(result.output).toContain("unknown provider");
    expect(result.provider).toBe("zz-does-not-exist");
    // zero upstream requests — the failure happened before any client call
    expect(port.requests).toHaveLength(0);
    close();
  });
});
