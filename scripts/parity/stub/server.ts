import { appendFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";

import type { StubLaneStep } from "../types.js";
import type { StubRuntime } from "./types.js";

const model = "stub-coder:1b";
const toolPath = "tool-target.txt";

// contract decision 25's own frozen text (buildSubagentSystemPrompt) — a
// child's system message always contains this sentence, a parent's never
// does. Byte-known, measured, not a guess: the same marker the T13 baseline
// evidence itself used (SUBAGENT_HEAD) to tell parent and child requests
// apart.
const SUBAGENT_MARKER = "You are an isolated subagent spawned to complete one specific task.";

/** True only for chat-lane-script — every other fixture has no lanes and
 * this function is never called for them. */
function isChildRequest(messages: readonly Record<string, unknown>[]): boolean {
  return messages.some(
    (entry) => entry.role === "system" && typeof entry.content === "string" && entry.content.includes(SUBAGENT_MARKER),
  );
}

/** SCEN:<name> is test-authored prompt text, not a product-emitted field —
 * the candidate never knows this convention exists, it just forwards
 * whatever prompt it was given (its own argv, or a spawn_session/
 * delegate_task tool call's own prompt argument) unmodified, the same as it
 * would for any other prompt. Falls back to "default" when no lane is
 * declared (a scenario with a single lane doesn't need to tag it). */
function laneOf(messages: readonly Record<string, unknown>[]): string {
  for (const entry of messages) {
    if (entry.role !== "user") continue;
    const content = typeof entry.content === "string" ? entry.content : "";
    const match = /SCEN:([A-Za-z0-9_]+)/.exec(content);
    if (match?.[1] !== undefined) return match[1];
  }
  return "default";
}

const SUB_ID_IN_TOOL_CONTENT = /"sub_id":\s*"([0-9a-f]{32})"/g;

/** Mirrors the Evaluator's own harness-fake_upstream.py _sub_ids: every
 * sub_id this request's history has seen, in order of first appearance,
 * read purely out of role:"tool" message content the loop already appended
 * — no product cooperation, the stub just observes what the conversation
 * already carries. */
function subIdsSeen(messages: readonly Record<string, unknown>[]): readonly string[] {
  const seen: string[] = [];
  for (const entry of messages) {
    if (entry.role !== "tool") continue;
    const content = typeof entry.content === "string" ? entry.content : "";
    for (const match of content.matchAll(SUB_ID_IN_TOOL_CONTENT)) {
      const subId = match[1];
      if (subId !== undefined && !seen.includes(subId)) seen.push(subId);
    }
  }
  return seen;
}

/** Mirrors the Evaluator's own _resolve: replaces "__SUB__" (most recently
 * seen) / "__SUBn__" (nth seen, 1-indexed) sentinel strings anywhere in a
 * parsed JSON value with a real sub_id — the same literal "__NO_SUB__"
 * error marker when the index doesn't resolve. Lets a manifest script a
 * collect_session/steer_session call against a sub_id it can't know ahead
 * of authoring time. */
function resolveSubSentinels(value: unknown, subs: readonly string[]): unknown {
  if (typeof value === "string") {
    if (value === "__SUB__") return subs.length > 0 ? subs[subs.length - 1] : "__NO_SUB__";
    const indexed = /^__SUB(\d+)__$/.exec(value);
    if (indexed?.[1] !== undefined) {
      const index = Number(indexed[1]) - 1;
      return index >= 0 && index < subs.length ? subs[index] : "__NO_SUB__";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveSubSentinels(entry, subs));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveSubSentinels(entry, subs)]),
    );
  }
  return value;
}

/** No-op for every scenario that never writes a __SUB sentinel (checked via
 * a cheap substring guard before ever parsing JSON) — byte-identical to the
 * raw scripted string, preserving every existing lane-script fixture's
 * proven no-op guarantee. */
function resolveArgumentsRaw(argumentsRaw: string, subs: readonly string[]): string {
  if (!argumentsRaw.includes("__SUB")) return argumentsRaw;
  const parsed: unknown = JSON.parse(argumentsRaw);
  return JSON.stringify(resolveSubSentinels(parsed, subs));
}

/** stepIndex is the lane's own step counter (not the call's position within
 * ONE step's calls array) — a lane that makes several separate tool_calls
 * steps in the same conversation (e.g. spawn_session, then steer_session,
 * then a probe) would otherwise mint the SAME "call_lane_<lane>_0" id for
 * every one of them, since each step's own calls array restarts at index 0.
 * Colliding ids corrupt --json's tool_calls aggregation on both sides
 * (matched/grouped by id) — this is a stub-only artifact, not a product
 * behavior, so it must never leak into an observed divergence. */
function nextLaneStep(
  runtime: StubRuntime,
  lane: string,
): { readonly step: StubLaneStep | undefined; readonly stepIndex: number } {
  const stepIndex = runtime.laneStepIndex.get(lane) ?? 0;
  runtime.laneStepIndex.set(lane, stepIndex + 1);
  return { step: runtime.laneSteps[lane]?.[stepIndex], stepIndex };
}

/** A named one-shot latch: fireLatch resolves it (creating it first if
 * nothing has awaited it yet, so an early signal still "sticks" for a
 * later awaiter — order-independent by construction). awaitLatch always
 * returns the same promise for a given name. In-process only: this stub
 * and the scenario's driver share one Node process, so no cross-process
 * file signaling (the Python reference implementation's own approach) is
 * needed here — same barrier semantics, fewer moving parts. */
function getOrCreateLatch(runtime: StubRuntime, name: string): { promise: Promise<void>; resolve: () => void } {
  const existing = runtime.latches.get(name);
  if (existing !== undefined) return existing;
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  const latch = { promise, resolve };
  runtime.latches.set(name, latch);
  return latch;
}

function fireLatch(runtime: StubRuntime, name: string): void {
  getOrCreateLatch(runtime, name).resolve();
}

/** Exported so a same-process test can synchronize on the exact same latch
 * a lane step signals — real async causality (a shared microtask queue),
 * not a wall-clock margin, to observe "this step's gate wait genuinely
 * suspended it" from outside the stub. */
export function awaitLatch(runtime: StubRuntime, name: string): Promise<void> {
  return getOrCreateLatch(runtime, name).promise;
}

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
  // lane/isChild are only ever attached under chat-lane-script — every
  // other fixture's projected/raw log entry keeps the exact same shape it
  // had before this field existed, byte for byte.
  const messages =
    typeof body === "object" && body !== null && Array.isArray((body as { messages?: unknown }).messages)
      ? ((body as { messages: Record<string, unknown>[] }).messages)
      : [];
  const laneFields =
    runtime.fixture === "chat-lane-script"
      ? { lane: laneOf(messages), isChild: isChildRequest(messages) }
      : {};
  const stable = { seq: runtime.requests, method, path, headers, body, ...laneFields };
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

function toolCall(
  name: string,
  argumentsRaw = JSON.stringify({ path: toolPath }),
  id = "call_stub_s1",
): Readonly<Record<string, unknown>> {
  return {
    id,
    type: "function",
    function: { name, arguments: argumentsRaw },
  };
}

export function completion(
  message: unknown,
  finishReason: string,
  includeUsage = true,
): Readonly<Record<string, unknown>> {
  return {
    id: "chatcmpl-stub-001",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(includeUsage ? { usage: usage() } : {}),
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
  const noTools = runtime.scenario.includes("no-tools") || runtime.scenario.startsWith("t08-");
  if (noTools && "tools" in body) {
    runtime.failures.push("NO_TOOLS_KEY_PRESENT");
  }
  if (!noTools && !runtime.scenario.includes("provider-without") && !Array.isArray(body.tools)) {
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
  const hasDeclaredPreviousStep =
    runtime.fixture === "chat-tool-sequence" &&
    runtime.toolSequence[runtime.posts - 2] !== undefined;
  if (
    runtime.fixture.includes("tool") &&
    ((runtime.fixture === "chat-tool-sequence" && hasDeclaredPreviousStep) ||
      (runtime.fixture !== "chat-tool-sequence" && runtime.posts === 2))
  ) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const roles = messages.map((entry) =>
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).role : null,
    );
    const declared = runtime.toolSequence[runtime.posts - 2];
    const expectedToolCount = declared?.calls.length ?? 1;
    const expectedRoles = [
      "system",
      "user",
      "assistant",
      ...Array.from({ length: expectedToolCount }, () => "tool"),
    ];
    if (JSON.stringify(roles) !== JSON.stringify(expectedRoles)) {
      runtime.failures.push("TOOL_ROLE_SEQUENCE");
    }
    const defaults = [
      {
        expectedResult:
          runtime.fixture === "chat-tool-unknown"
            ? '{"error": "Unknown tool: no_such_tool_xyz"}'
            : '{"ok": true, "data": "STUB-TOOL-EVIDENCE v1\\n", "truncated": false, "path": "tool-target.txt"}',
        validation: "exact" as const,
      },
    ];
    for (const [index, expected] of (declared?.calls ?? defaults).entries()) {
      const toolMessage = messages[3 + index] as Record<string, unknown> | undefined;
      if (
        toolMessage === undefined ||
        JSON.stringify(Object.keys(toolMessage)) !==
          JSON.stringify(["role", "tool_call_id", "content"])
      ) {
        runtime.failures.push("TOOL_MESSAGE_SHAPE");
      }
      if (expected.validation !== "skip" && toolMessage?.content !== expected.expectedResult) {
        runtime.failures.push("TOOL_RESULT_MISMATCH");
      }
    }
  }
}

/**
 * T13 multi-lane orchestration fixture. Every step's coordination fields
 * are applied strictly in this order — signal (announce arrival) before any
 * wait, then awaitSignal/gate (block on another lane's step), then
 * openGate (release waiters) — so a scenario can force "these N requests
 * arrived before this barrier opened" without any wall-clock dependency.
 * Streams unconditionally when the request asks for it (children always
 * stream, contract L2) since this fixture has no non-streaming-only
 * precedent to inherit.
 */
async function handleLaneScript(
  runtime: StubRuntime,
  body: Record<string, unknown>,
  response: import("node:http").ServerResponse,
): Promise<void> {
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const lane = laneOf(messages);
  const { step, stepIndex } = nextLaneStep(runtime, lane);
  if (step?.signal !== undefined) fireLatch(runtime, step.signal);
  if (step?.awaitSignal !== undefined) await awaitLatch(runtime, step.awaitSignal);
  if (step?.gate !== undefined) await awaitLatch(runtime, step.gate);
  if (step?.openGate !== undefined) fireLatch(runtime, step.openGate);

  if (step?.kind === "http_error") {
    const payload = Buffer.from(
      JSON.stringify({ error: { message: step.message ?? "boom", type: "teapot_error" } }),
    );
    response.writeHead(step.status ?? 418, {
      "content-type": "application/json",
      "content-length": String(payload.length),
      ...step.headers,
    });
    response.end(payload);
    return;
  }

  const msg: Record<string, unknown> = { role: "assistant", content: null };
  let finish: string;
  if (step?.kind === "tool_calls" && step.calls !== undefined) {
    const subs = subIdsSeen(messages);
    msg.tool_calls = step.calls.map((call, index) =>
      toolCall(
        call.name,
        resolveArgumentsRaw(call.argumentsRaw, subs),
        `call_lane_${lane}_${String(stepIndex)}_${String(index)}`,
      ),
    );
    finish = "tool_calls";
  } else {
    msg.content = step?.content ?? "FINAL-DEFAULT";
    finish = "stop";
  }

  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: null }))}\n\n`);
    if (finish === "tool_calls" && Array.isArray(msg.tool_calls)) {
      const calls = msg.tool_calls as readonly Readonly<Record<string, unknown>>[];
      calls.forEach((call, index) => {
        const fn = call.function as { readonly name: string; readonly arguments: string };
        response.write(
          `data: ${JSON.stringify(
            chunk({
              tool_calls: [
                { index, id: call.id, type: "function", function: { name: fn.name, arguments: fn.arguments } },
              ],
            }),
          )}\n\n`,
        );
      });
    } else if (typeof msg.content === "string") {
      response.write(`data: ${JSON.stringify(chunk({ content: msg.content }))}\n\n`);
    }
    response.write(`data: ${JSON.stringify(chunk({}, finish))}\n\n`);
    response.write(`data: ${JSON.stringify({ ...chunk({}), choices: [], usage: usage() })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  json(response, 200, completion(msg, finish));
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
  if (runtime.fixture !== "chat-lane-script") validateBody(runtime, body);
  if (runtime.fixture === "chat-lane-script") {
    await handleLaneScript(runtime, body, response);
    return;
  }
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
    runtime.posts === 1 &&
    ["chat-tool", "chat-tool-unknown", "chat-incomplete-tool"].includes(runtime.fixture);
  if (firstTool) {
    const name = runtime.fixture === "chat-tool-unknown" ? "no_such_tool_xyz" : "read_file";
    const call =
      runtime.fixture === "chat-incomplete-tool"
        ? { id: "call_stub_s1", type: "function" }
        : toolCall(name);
    json(
      response,
      200,
      completion({ role: "assistant", content: null, tool_calls: [call] }, "tool_calls"),
    );
    return;
  }
  const declaredStep = runtime.toolSequence[runtime.posts - 1];
  if (runtime.fixture === "chat-tool-sequence" && declaredStep !== undefined) {
    json(
      response,
      200,
      completion(
        {
          role: "assistant",
          content: null,
          tool_calls: declaredStep.calls.map((declaredCall, index) =>
            toolCall(
              declaredCall.name,
              declaredCall.argumentsRaw,
              declaredStep.calls.length === 1
                ? `call_stub_s${String(runtime.posts)}`
                : `call_stub_s${String(runtime.posts)}_${String(index + 1)}`,
            ),
          ),
        },
        "tool_calls",
      ),
    );
    return;
  }
  const text =
    runtime.fixture === "chat-del"
      ? `a${String.fromCharCode(0x7f)}b`
      : runtime.fixture === "side-divergent" && runtime.side === "candidate"
        ? "STUB-MUTANT: divergent reply"
        : "STUB-OK: deterministic reply";
  json(
    response,
    200,
    completion({ role: "assistant", content: text }, "stop", runtime.fixture !== "chat-no-usage"),
  );
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
