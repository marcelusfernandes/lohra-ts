import { appendFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";

import type { StubRuntime } from "./types.js";

const model = "stub-coder:1b";
const toolPath = "tool-target.txt";

function append(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function lowerHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(", ") : (value ?? ""),
    ]),
  );
}

function recordRequest(runtime: StubRuntime, request: IncomingMessage, body: unknown): void {
  runtime.requests += 1;
  const method = request.method ?? "";
  const path = request.url ?? "";
  runtime.sequence.push(`${method} ${path}`);
  const rawHeaders = lowerHeaders(request.headers);
  for (const key of Object.keys(rawHeaders)) {
    if (!runtime.comparedHeaders.includes(key) && !runtime.excludedHeaders.includes(key)) {
      runtime.failures.push(`REQUEST_HEADER_UNCLASSIFIED:${key}`);
    }
  }
  const headers = Object.fromEntries(
    runtime.comparedHeaders.map((key) => [key, rawHeaders[key] ?? null]),
  );
  const stable = { seq: runtime.requests, method, path, headers, body };
  append(runtime.projectedLog, stable);
  append(runtime.rawLog, { ...stable, headers: rawHeaders });
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
  });
  response.end(body);
}

function usage(): Readonly<Record<string, number>> {
  return { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
}

function toolCall(name: string): Readonly<Record<string, unknown>> {
  return {
    id: "call_stub_s1",
    type: "function",
    function: { name, arguments: JSON.stringify({ path: toolPath }) },
  };
}

function completion(message: unknown, finishReason: string): Readonly<Record<string, unknown>> {
  return {
    id: "chatcmpl-stub-001",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: usage(),
  };
}

function chunk(
  delta: unknown,
  finishReason: string | null = null,
): Readonly<Record<string, unknown>> {
  return {
    id: "chatcmpl-stub-001",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function streamFrames(runtime: StubRuntime, firstPost: boolean): readonly unknown[] {
  const tool =
    firstPost &&
    (runtime.fixture === "chat-tool-stream" || runtime.fixture === "chat-tool-unknown");
  if (!tool) {
    const text =
      runtime.fixture === "side-divergent" && runtime.side === "candidate"
        ? "STUB-MUTANT: divergent reply"
        : "STUB-OK: deterministic reply";
    return [
      chunk({ role: "assistant", content: null }),
      chunk({ content: text }),
      chunk({}, "stop"),
      { ...chunk({}), choices: [], usage: usage() },
    ];
  }
  const name = runtime.fixture === "chat-tool-unknown" ? "no_such_tool_xyz" : "read_file";
  return [
    chunk({ role: "assistant", content: null }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_stub_s1",
          type: "function",
          function: { name, arguments: "" },
        },
      ],
    }),
    chunk({
      tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: toolPath }) } }],
    }),
    chunk({}, "tool_calls"),
    { ...chunk({}), choices: [], usage: usage() },
  ];
}

function validateBody(runtime: StubRuntime, body: Record<string, unknown>): void {
  const stream = body.stream === true;
  if (runtime.scenario.includes("no-tools") && "tools" in body) {
    runtime.failures.push("NO_TOOLS_KEY_PRESENT");
  }
  if (
    !runtime.scenario.includes("no-tools") &&
    !runtime.scenario.includes("provider-without") &&
    !Array.isArray(body.tools)
  ) {
    runtime.failures.push("TOOLS_MISSING");
  }
  if (stream) {
    const includeUsage = (body.stream_options as { include_usage?: unknown } | undefined)
      ?.include_usage;
    if (runtime.fixture === "chat-stream-options-400" && runtime.posts === 2) {
      if ("stream_options" in body) runtime.failures.push("STREAM_OPTIONS_RETRY_PRESENT");
    } else if (includeUsage !== true) {
      runtime.failures.push("STREAM_OPTIONS_MISSING");
    }
  }
  if (!stream && ("stream" in body || "stream_options" in body)) {
    runtime.failures.push("NONSTREAM_HAS_STREAM_FIELDS");
  }
  if (body.max_tokens !== 8192) runtime.failures.push("MAX_TOKENS_MISMATCH");
  if (body.model !== model) runtime.failures.push("MODEL_MISMATCH");
  if (runtime.posts === 2 && runtime.fixture.includes("tool")) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const roles = messages.map((entry) =>
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).role : null,
    );
    if (JSON.stringify(roles) !== JSON.stringify(["system", "user", "assistant", "tool"])) {
      runtime.failures.push("TOOL_ROLE_SEQUENCE");
    }
    const toolMessage = messages[3] as Record<string, unknown> | undefined;
    const expected =
      runtime.fixture === "chat-tool-unknown"
        ? '{"error": "Unknown tool: no_such_tool_xyz"}'
        : '{"ok": true, "data": "STUB-TOOL-EVIDENCE v1\\n", "truncated": false, "path": "tool-target.txt"}';
    if (toolMessage?.content !== expected) runtime.failures.push("TOOL_RESULT_MISMATCH");
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<unknown>) {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    else throw new Error("request body emitted a non-byte chunk");
  }
  return Buffer.concat(chunks);
}

async function handle(
  runtime: StubRuntime,
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  const raw = await readBody(request);
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      parsed = raw.toString("utf8");
    }
  }
  recordRequest(runtime, request, parsed);
  if (request.method === "GET" && request.url === "/api/tags") {
    json(response, 200, {
      models: runtime.state === "up-empty-models" ? [] : [{ name: model }],
    });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    json(response, 404, { error: { message: "stub: not found", type: "invalid_request_error" } });
    return;
  }
  runtime.posts += 1;
  const body =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  validateBody(runtime, body);
  if (runtime.fixture === "chat-http-401") {
    json(response, 401, {
      error: {
        message: "stub: invalid api key",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    return;
  }
  if (runtime.fixture === "chat-http-500") {
    json(response, 500, { error: { message: "stub: internal error", type: "api_error" } });
    return;
  }
  if (runtime.fixture === "chat-stream-options-400" && runtime.posts === 1) {
    json(response, 400, {
      error: { message: "'stream_options' is not supported", type: "invalid_request_error" },
    });
    return;
  }
  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const frame of streamFrames(runtime, runtime.posts === 1)) {
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
    if (runtime.fixture !== "chat-stream-nodone") response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  const firstTool =
    runtime.posts === 1 && ["chat-tool", "chat-tool-unknown"].includes(runtime.fixture);
  if (firstTool) {
    const name = runtime.fixture === "chat-tool-unknown" ? "no_such_tool_xyz" : "read_file";
    json(
      response,
      200,
      completion({ role: "assistant", content: null, tool_calls: [toolCall(name)] }, "tool_calls"),
    );
    return;
  }
  const text =
    runtime.fixture === "side-divergent" && runtime.side === "candidate"
      ? "STUB-MUTANT: divergent reply"
      : "STUB-OK: deterministic reply";
  json(response, 200, completion({ role: "assistant", content: text }, "stop"));
}

export async function startStub(runtime: StubRuntime): Promise<Server> {
  const server = createServer((request, response) => {
    void handle(runtime, request, response).catch((error: unknown) => {
      runtime.failures.push(
        `STUB_HANDLER:${error instanceof Error ? error.message : String(error)}`,
      );
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(11_434, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
