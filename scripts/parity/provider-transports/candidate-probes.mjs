#!/usr/bin/env node
import process from "node:process";
import { TextEncoder } from "node:util";

const Headers = globalThis.Headers;

import { AuxClient, ClientPool } from "../../../dist/agent/index.js";
import { pythonJsonLoads } from "../../../dist/serialization/python-json.js";
import {
  CODEX_PROVIDER,
  getMaxTokens,
  getProviderProfile,
  listProviders,
  registerProvider,
  resolveProviderName,
} from "../../../dist/providers/index.js";
import {
  AnthropicMessagesTransport,
  ChatCompletionsTransport,
  ResponsesClient,
  ResponsesTransport,
  buildClient,
  classifyProviderError,
  getTransport,
  listTransports,
  retryAfterSeconds,
} from "../../../dist/transports/index.js";

const chat = new ChatCompletionsTransport();
const anthropic = new AnthropicMessagesTransport();
const responses = new ResponsesTransport();
const base = {
  model: "m",
  messages: [
    { role: "system", content: "HIST" },
    { role: "user", content: "hi" },
  ],
  system: "TOP",
};
const simple = (value) => JSON.parse(JSON.stringify(value));
const normalized = (value) => ({
  content: value.content,
  finish_reason: value.finishReason,
  tool_calls: value.toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    provider_data: call.providerData,
  })),
  reasoning: value.reasoning,
  usage:
    value.usage === null
      ? null
      : {
          input_tokens: value.usage.inputTokens,
          output_tokens: value.usage.outputTokens,
          cache_read_tokens: value.usage.cacheReadTokens,
          cache_write_tokens: value.usage.cacheWriteTokens,
          reasoning_tokens: value.usage.reasoningTokens,
        },
  provider_data: value.providerData,
});
const caught = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const builtins = listProviders();
const result = {};
result["t10-registry-eleven-codex-absent-buildclient-refusal"] = {
  names: builtins.map((profile) => profile.name),
  codex_lookup: getProviderProfile("openai-codex"),
  codex: {
    name: CODEX_PROVIDER.name,
    api_mode: CODEX_PROVIDER.apiMode,
    requires_api_key: CODEX_PROVIDER.requiresApiKey,
    auth_type: CODEX_PROVIDER.authType,
    fallback_models: CODEX_PROVIDER.fallbackModels,
    default_aux_model: CODEX_PROVIDER.defaultAuxModel,
  },
  refusal: await caught(() => buildClient(CODEX_PROVIDER, "x")),
};
result["t10-profile-snapshot-and-resolution-order"] = builtins.map((profile) => ({
  name: profile.name,
  api_mode: profile.apiMode,
  aliases: profile.aliases,
  env_vars: profile.envVars,
  supports_vision: profile.supportsVision,
  fallback_models: profile.fallbackModels,
  default_max_tokens: profile.defaultMaxTokens,
  default_aux_model: profile.defaultAuxModel,
  max_any: getMaxTokens(profile.name, "anything"),
  default_headers: profile.defaultHeaders,
  fixed_temperature: profile.fixedTemperature,
}));
registerProvider({
  ...CODEX_PROVIDER,
  name: "ZZTest",
  aliases: ["UPPER"],
  apiMode: "chat_completions",
});
result["t10-registry-case-and-whitespace"] = {
  lookups: ["ZZTest", "zztest", "UPPER", "upper", " claude"].map(
    (name) => getProviderProfile(name)?.name ?? null,
  ),
  resolved: resolveProviderName(" claude"),
};
result["t10-transport-registry-three"] = {
  names: listTransports(),
  classes: listTransports().map((mode) => getTransport(mode)?.constructor.name),
};
result["t10-build-system-three-way"] = [chat, anthropic, responses].map((transport) =>
  simple(transport.buildKwargs(base)),
);
result["t10-build-max-tokens-three-way"] = [null, 0].map((maxTokens) =>
  [chat, anthropic, responses].map((transport) =>
    simple(transport.buildKwargs({ model: "m", messages: [], maxTokens })),
  ),
);
result["t10-build-tool-choice-without-tools"] = [chat, anthropic, responses].map((transport) =>
  simple(transport.buildKwargs({ model: "m", messages: [], toolChoice: "named" })),
);
result["t10-build-effort-three-way"] = [chat, anthropic, responses].map((transport) =>
  simple(transport.buildKwargs({ model: "m", messages: [], effort: "high" })),
);
const roles = [
  { role: "developer", content: "d" },
  { role: null, content: "n" },
];
result["t10-build-roles-three-way"] = [chat, anthropic, responses].map((transport) =>
  simple(transport.buildKwargs({ model: "m", messages: roles })),
);
const argumentsMessages = [
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "a", function: { name: "x", arguments: { k: 1 } } },
      { id: "b", function: { name: "x", arguments: "{" } },
    ],
  },
];
result["t10-build-arguments-three-way"] = [chat, anthropic, responses].map((transport) =>
  simple(transport.buildKwargs({ model: "m", messages: argumentsMessages })),
);
const vision = [
  {
    role: "user",
    content: [
      { type: "text", text: "x" },
      { type: "image_url", image_url: { url: "data:,noheader" } },
      { type: "image_url", image_url: { url: "https://example.test/x.png" } },
    ],
  },
];
result["t10-build-vision-three-way"] = [chat, anthropic, responses].map((transport) =>
  simple(transport.buildKwargs({ model: "m", messages: vision })),
);
const chatSchema = { type: "object", properties: { x: { type: "string" } } };
const anthSchema = { type: "object", properties: { x: { type: "string" } } };
const respSchema = { type: "object", properties: { x: { type: "string" } } };
const chatBuilt = chat.buildKwargs({
  model: "m",
  messages: [],
  tools: [{ type: "function", function: { name: "x", parameters: chatSchema } }],
});
const anthBuilt = anthropic.buildKwargs({
  model: "m",
  messages: [],
  tools: [{ type: "function", function: { name: "x", parameters: anthSchema } }],
});
const respBuilt = responses.buildKwargs({
  model: "m",
  messages: [],
  tools: [{ type: "function", function: { name: "x", parameters: respSchema } }],
});
chatSchema.properties.x.type =
  anthSchema.properties.x.type =
  respSchema.properties.x.type =
    "number";
result["t10-tool-schema-mutation-three-way"] = {
  classification: "expected-divergence-anthropic-alias-only",
  chat_changed: chatBuilt.tools[0].function.parameters.properties.x.type === "number",
  anthropic_changed: anthBuilt.tools[0].input_schema.properties.x.type === "number",
  responses_changed: respBuilt.tools[0].parameters.properties.x.type === "number",
};
const anthRaw = pythonJsonLoads(
  '{"content":[{"type":"thinking","signature":"s","thinking":"r"},{"type":"redacted_thinking","data":"b"},{"type":"text","text":"x"},{"type":"tool_use","id":"c","name":"read","input":{"path":"café","whole":1.0,"nested":{"value":2.0},"array":[3.0],"exponent":1e2,"integer":7}}],"stop_reason":"pause_turn","usage":{"input_tokens":70,"output_tokens":30,"cache_read_input_tokens":5}}',
);
result["t10-anthropic-normalize-stop-and-thinking"] = normalized(
  anthropic.normalizeResponse(anthRaw),
);
const respRaw = {
  status: "incomplete",
  output: [
    { type: "reasoning", summary: [{ text: "why" }], encrypted_content: "enc" },
    { type: "message", content: [{ type: "refusal", refusal: "no" }] },
  ],
  usage: {
    input_tokens: 20,
    output_tokens: 7,
    input_tokens_details: { cached_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 3 },
  },
};
result["t10-responses-normalize-status-refusal"] = normalized(responses.normalizeResponse(respRaw));
result["t10-responses-replay-filter"] = simple(
  responses.buildKwargs({
    model: "m",
    messages: [
      {
        role: "assistant",
        content: "a",
        provider_data: {
          reasoning_items: [
            { type: "reasoning", summary: [], encrypted_content: "enc" },
            { type: "reasoning", summary: [], encrypted_content: null },
          ],
        },
      },
    ],
  }),
);
const events = [
  {
    type: "response.output_item.done",
    item: { type: "message", content: [{ type: "output_text", text: "ok" }] },
  },
  {
    type: "response.completed",
    response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
  },
];
const http = {
  post: async () => ({
    status: 200,
    headers: new Headers(),
    body: new TextEncoder().encode(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    ),
  }),
};
result["t10-responses-stream-assembly"] = normalized(
  await new ResponsesClient({ baseUrl: "http://x", token: "t", transport: responses, http }).create(
    { model: "m", input: [] },
  ),
);
result["t10-usage-three-conventions"] = [
  normalized(
    chat.normalizeResponse({
      choices: [{ message: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 70,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    }),
  ).usage,
  normalized(anthropic.normalizeResponse(anthRaw)).usage,
  normalized(responses.normalizeResponse(respRaw)).usage,
];
result["t10-chat-kimi-cache-clamp"] = normalized(
  chat.normalizeResponse({
    choices: [{ message: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1, cached_tokens: 999 },
  }),
).usage;
result["t10-error-classification-real-and-simple"] = [
  Object.assign(new Error("x"), { statusCode: 429 }),
  Object.assign(new Error("x"), { status: "429" }),
  Object.assign(new Error("x"), { code: "quota_exceeded" }),
  Object.assign(new Error("x"), { code: "QUOTA_EXCEEDED" }),
].map(classifyProviderError);
result["t10-retry-after-case-sensitivity"] = [
  retryAfterSeconds({ response: { headers: { "retry-after": "30" } } }),
  retryAfterSeconds({ response: { headers: { "Retry-After": "30" } } }),
  retryAfterSeconds({ response: { headers: new Headers({ "Retry-After": "30" }) } }),
];
const parent = getProviderProfile("anthropic");
const parentClient = { close() {} };
const pool = new ClientPool(parent, parentClient, {
  home: process.env.LOHRA_HOME,
  environment: {},
});
result["t10-client-pool-routing-gates"] = {
  unknown: await caught(() => pool.get("nope-xyz")),
  no_key: await caught(() => pool.get("groq")),
  codex: await caught(() => pool.get("openai-codex")),
};
let closes = 0;
const pool2 = new ClientPool(parent, parentClient, {
  home: process.env.LOHRA_HOME,
  environment: { OPENAI_API_KEY: "dummy" },
  build: () => ({
    close() {
      closes += 1;
    },
  }),
});
const borrowed = (await pool2.get(null))[1] === parentClient;
const alias = await caught(() => pool2.get("claude"));
await pool2.get("openai");
await pool2.close();
await pool2.close();
result["t10-client-pool-alias-close"] = { borrowed, alias, closes };
const auxCalls = [];
const auxClient = {
  create: async (kwargs) => {
    auxCalls.push(kwargs);
    return {
      content: " aux ",
      finishReason: "stop",
      toolCalls: [],
      reasoning: null,
      usage: null,
      providerData: null,
    };
  },
};
const chatAux = new AuxClient({
  client: auxClient,
  transport: chat,
  chosenModel: "chosen",
  defaultAuxModel: "aux",
});
result["t10-aux-title-three-way"] = {
  output: await chatAux.title("text"),
  kwargs: auxCalls.at(-1),
};
result["t10-aux-summary-three-way"] = {
  output: await chatAux.summarize("text"),
  kwargs: auxCalls.at(-1),
};
result["t10-usage-empty-object-accounting"] = [
  normalized(
    chat.normalizeResponse({ choices: [{ message: {}, finish_reason: "stop" }], usage: {} }),
  ).usage,
  normalized(anthropic.normalizeResponse({ content: [], usage: {} })).usage,
  normalized(responses.normalizeResponse({ output: [], usage: {} })).usage,
];
result["t10-chat-canonical-finish-map"] = ["pause", "tool_calls", "weird"].map(
  (finish_reason) =>
    normalized(chat.normalizeResponse({ choices: [{ message: {}, finish_reason }] })).finish_reason,
);

process.stdout.write(`${JSON.stringify(result)}\n`);
