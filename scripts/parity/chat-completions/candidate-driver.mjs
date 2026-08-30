#!/usr/bin/env node
import process from "node:process";
import {
  assembleStreamedResponse,
  ChatCompletionsClient,
  ChatCompletionsTransport,
  classifyProviderError,
  ProviderCallFailed,
  RateLimitError,
  resolveChatCompletionsTarget,
  retryAfterSeconds,
} from "../../../dist/transports/index.js";
import { listProviders } from "../../../dist/providers/index.js";
import { pythonFloat, pythonJsonDumps } from "../../../dist/serialization/python-json.js";

const mode = process.argv[2];
const transport = new ChatCompletionsTransport();

function emit(value) {
  process.stdout.write(`${pythonJsonDumps(prepareFloats(value))}\n`);
}

function prepareFloats(value) {
  if (value?.constructor?.name === "PythonFloat") return value;
  if (typeof value === "number" && !Number.isInteger(value)) return pythonFloat(value);
  if (Array.isArray(value)) return value.map(prepareFloats);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, prepareFloats(item)]),
    );
  return value;
}

function usage(value) {
  if (value === null) return null;
  return {
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    cache_read_tokens: value.cacheReadTokens,
    cache_write_tokens: value.cacheWriteTokens,
    reasoning_tokens: value.reasoningTokens,
  };
}

function normalized(value) {
  return {
    content: value.content,
    finish_reason: value.finishReason,
    tool_calls: value.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      provider_data: call.providerData,
    })),
    reasoning: value.reasoning,
    usage: usage(value.usage),
    provider_data: value.providerData,
  };
}

function chunk(delta, finish_reason = null) {
  return { choices: [{ delta, finish_reason }] };
}

function buildCore() {
  return transport.buildKwargs({
    model: "m",
    system: "TOP",
    messages: [
      { role: "system", content: "INLINE" },
      { role: "weird", content: "user" },
      { role: "tool", tool_call_id: "c1", content: null },
    ],
  });
}

function buildBoundaries() {
  return transport.buildKwargs({
    model: "m",
    messages: [],
    tools: [],
    maxTokens: 0,
    temperature: 0,
    effort: "",
    toolChoice: "",
  });
}

function buildUnicode(mutant = false) {
  const raw = `a${String.fromCharCode(0x7f)}b`;
  const result = transport.buildKwargs({
    model: "m",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "s", function: { name: "string", arguments: raw } },
          { id: "o", function: { name: "object", arguments: { k: raw } } },
        ],
      },
    ],
  });
  if (!mutant) return result;
  const calls = result.messages[0].tool_calls;
  calls[1].function.arguments = JSON.stringify({ k: raw });
  return result;
}

function buildCopy() {
  const messages = [{ role: "user", content: [{ type: "text", text: "x" }] }];
  const tools = [{ type: "function", function: { name: "f", parameters: { type: "object" } } }];
  const before = pythonJsonDumps({ messages, tools });
  const result = transport.buildKwargs({ model: "m", messages, tools });
  result.tools[0].function.parameters.changed = true;
  return {
    input_unchanged: before === pythonJsonDumps({ messages, tools }),
    tools_copied: !tools[0].function.parameters.changed,
  };
}

function response(finish = "stop", extra = {}) {
  return {
    choices: [{ message: { content: "x", ...extra }, finish_reason: finish }],
  };
}

function usageResponse(prompt, detail, top, completion = 0, reasoning = 0) {
  return transport.normalizeResponse({
    ...response(),
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      cached_tokens: top,
      prompt_tokens_details: { cached_tokens: detail },
      completion_tokens_details: { reasoning_tokens: reasoning },
    },
  }).usage;
}

function streamContent(reasoningMutant = false) {
  const callbacks = [];
  const raw = assembleStreamedResponse(
    [
      chunk({ content: "a" }),
      chunk({ reasoning_content: "r1" }),
      chunk({ content: "b", reasoning_content: "r2" }, "stop"),
    ],
    {
      onText: (v) => callbacks.push(["text", v]),
      onReasoning: (v) => callbacks.push(["reasoning", v]),
    },
  );
  const result = normalized(transport.normalizeResponse(raw));
  if (reasoningMutant) result.reasoning = "r1r2";
  return { callbacks, result };
}

function streamUsage() {
  const raw = assembleStreamedResponse([
    { choices: [], usage: { prompt_tokens: 1 } },
    chunk({ content: "x" }, "stop"),
    { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
  ]);
  return normalized(transport.normalizeResponse(raw));
}

function streamTools() {
  const raw = assembleStreamedResponse([
    chunk({ tool_calls: [{ index: 2, function: { arguments: '{"a":' } }] }),
    chunk({ tool_calls: [{ index: 1, id: "c1", function: { name: "second", arguments: "{}" } }] }),
    chunk(
      { tool_calls: [{ index: 2, id: "c2", function: { name: "first", arguments: "1}" } }] },
      "tool_calls",
    ),
  ]);
  return normalized(transport.normalizeResponse(raw));
}

function streamIncomplete() {
  const fixtures = [
    [chunk({}, "tool_calls")],
    [chunk({ tool_calls: [{ index: 0, function: { name: "x" } }] }, "tool_calls")],
    [chunk({ tool_calls: [{ index: 0, id: "c" }] }, "tool_calls")],
    [chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "" } }] }, "tool_calls")],
    [
      chunk(
        {
          tool_calls: [
            { index: 0, id: "good", function: { name: "ok" } },
            { index: 1, id: "bad" },
          ],
        },
        "tool_calls",
      ),
    ],
  ];
  return fixtures.map((chunks) => {
    try {
      assembleStreamedResponse(chunks);
      return "NO_ERROR";
    } catch (error) {
      return String(error.message);
    }
  });
}

function streamOrphan() {
  const warnings = [];
  const raw = assembleStreamedResponse(
    [chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "x" } }] }, "stop")],
    { onWarning: (value) => warnings.push(value) },
  );
  return { warnings, raw };
}

function errors() {
  const cases = [
    new RateLimitError("rate"),
    Object.assign(new Error("x"), { statusCode: 429 }),
    Object.assign(new Error("x"), { status: 429 }),
    Object.assign(new Error("x"), { code: "quota_exceeded" }),
    Object.assign(new Error("429 rate limit exceeded"), { status: "429" }),
    Object.assign(new Error("x"), { code: 429 }),
    new ProviderCallFailed("x", { statusCode: 500 }),
  ];
  return cases.map(classifyProviderError);
}

function retryAfter() {
  return [
    retryAfterSeconds({ retryAfter: "2.5", response: { headers: { "retry-after": "11" } } }),
    retryAfterSeconds({ response: { headers: { "Retry-After": "11" } } }),
    ...[0, -1, true, "tomorrow", "Wed, 21 Oct 2015 07:28:00 GMT"].map((value) =>
      retryAfterSeconds({ retryAfter: value }),
    ),
  ].map((value) => (value === null ? null : pythonFloat(value)));
}

class QueuePort {
  constructor(queue) {
    this.queue = queue;
    this.requests = [];
  }
  async post(request) {
    this.requests.push(request);
    const value = this.queue.shift();
    if (value instanceof Error) throw value;
    return value;
  }
}

async function timeoutRetry() {
  const body = new globalThis.TextEncoder().encode(
    `data: ${JSON.stringify(chunk({ content: "ok" }, "stop"))}\n\n`,
  );
  const port = new QueuePort([
    new Error("timeout while sending stream_options"),
    { status: 200, headers: new globalThis.Headers(), body },
  ]);
  const client = new ChatCompletionsClient({
    baseUrl: "http://localhost:11434/v1",
    apiKey: "lohra-local",
    transport,
    http: port,
  });
  const result = await client.stream({ model: "m", messages: [] });
  return {
    requests: port.requests.map((request) => JSON.parse(request.body)),
    result: normalized(result),
  };
}

async function clientMode(kind) {
  const client = new ChatCompletionsClient({
    baseUrl: "http://localhost:11434/v1",
    apiKey: "lohra-local",
    transport,
  });
  const kwargs = transport.buildKwargs({
    model: "stub-coder:1b",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxTokens: 8192,
  });
  try {
    const value = kind === "stream" ? await client.stream(kwargs) : await client.create(kwargs);
    return { ok: true, response: normalized(value), classification: null };
  } catch (error) {
    return {
      ok: false,
      response: null,
      classification: classifyProviderError(error),
      status_code: typeof error.statusCode === "number" ? error.statusCode : null,
    };
  } finally {
    await client.close();
  }
}

function routing() {
  const env = Object.fromEntries(
    listProviders().flatMap((profile) =>
      profile.envVars.map((name) => [name, `${profile.name}-key`]),
    ),
  );
  const rows = listProviders().map((profile) => {
    try {
      const target = resolveChatCompletionsTarget(profile.name, env);
      return {
        name: target.profile.name,
        api_mode: target.profile.apiMode,
        key: target.apiKey ? "present" : "missing",
      };
    } catch (error) {
      return { name: profile.name, error: String(error.message) };
    }
  });
  return {
    rows,
    alias: resolveChatCompletionsTarget("OR", env).profile.name,
    ollama: resolveChatCompletionsTarget("ollama", {}).apiKey,
  };
}

async function run() {
  switch (mode) {
    case "build-core":
      return buildCore();
    case "build-boundaries":
      return buildBoundaries();
    case "build-unicode":
      return buildUnicode();
    case "json-stringify-mutant":
      return buildUnicode(true);
    case "build-copy":
      return buildCopy();
    case "normalize-core":
      return normalized(transport.normalizeResponse({ choices: [] }));
    case "normalize-finish":
      return [
        "stop",
        "length",
        "tool_calls",
        "function_call",
        "content_filter",
        null,
        "weird",
        "",
      ].map((v) => transport.normalizeResponse(response(v)).finishReason);
    case "normalize-tools":
      return normalized(
        transport.normalizeResponse(
          response("tool_calls", {
            content: null,
            reasoning_content: "thought",
            tool_calls: [{ id: null, function: { name: null, arguments: null } }],
          }),
        ),
      );
    case "usage-basic":
      return usage(usageResponse(100, 40, 0, 20, 7));
    case "usage-fallback":
      return [usage(usageResponse(100, 0, 40)), usage(usageResponse(100, 10, 40))];
    case "usage-negative":
      return [usage(usageResponse(10, 999, 0)), usage(usageResponse(-5, 999, 0))];
    case "stream-content-reasoning":
      return streamContent();
    case "stream-reasoning-mutant":
      return streamContent(true);
    case "stream-usage":
      return streamUsage();
    case "stream-tools":
      return streamTools();
    case "stream-incomplete":
      return streamIncomplete();
    case "stream-orphan":
      return streamOrphan();
    case "stream-callbacks":
      return streamContent();
    case "error-classification":
      return errors();
    case "retry-after":
      return retryAfter();
    case "client-timeout-prose-retry":
      return await timeoutRetry();
    case "provider-routing":
      return routing();
    case "client-nonstream":
      return await clientMode("nonstream");
    case "client-stream":
      return await clientMode("stream");
    default:
      throw new Error(`unknown mode: ${String(mode)}`);
  }
}

emit(await run());
