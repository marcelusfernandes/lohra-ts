// Loopback fake upstream for the T11 [socket-bilateral] harness. Both the
// oracle and the candidate `serve` processes point their (only) provider
// profile's base_url at this server via FAKE_BASE_URL, so every upstream
// call in a scenario lands here instead of the network — assertion 4 (zero
// egress). Behavior is driven by a `SCEN:<name>` marker at the start of the
// user's message content, matching the convention already used by the
// in-process server tests (tests/server-http-app.test.ts and friends): the
// scenario picks the marker, this fixture answers deterministically, and
// every request received is recorded so a scenario can assert an exact
// upstream request count (assertions 21/29/51/64).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface UpstreamRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly rawBody: string;
}

export interface FakeUpstream {
  readonly url: string;
  readonly requests: UpstreamRequestRecord[];
  close(): Promise<void>;
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (message?.["role"] !== "user") continue;
    const content = message["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          typeof part === "object" && part !== null
            ? (part as Record<string, unknown>)["text"]
            : "",
        )
        .filter((value) => typeof value === "string")
        .join("");
    }
  }
  return "";
}

function scenarioOf(body: Record<string, unknown>): string {
  const marker = lastUserText(body).match(/^SCEN:(\S+)/u);
  return marker?.[1] ?? "ok";
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sseFrames(response: ServerResponse, chunks: readonly string[], done = true): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunks.join("") + (done ? "data: [DONE]\n\n" : ""));
}

const USAGE = {
  prompt_tokens: 11,
  completion_tokens: 5,
  prompt_tokens_details: { cached_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 0 },
};

export const CAUSE_CANARY = "T11_CAUSE_CANARY";

function errorPayload(): { error: { message: string; type: string } } {
  return { error: { message: `${CAUSE_CANARY} upstream refused`, type: "teapot_error" } };
}

/** Body-based branching (never a call counter): the shared fake upstream
 * serves BOTH the oracle's and the candidate's calls within one scenario,
 * interleaved in a known but not necessarily 1:1-alternating order, so
 * "first call" must be read off the actual request content — the presence
 * of a `role:"tool"` result message, exactly what a real provider would
 * see — rather than a mutable counter. */
function hasToolResult(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : [];
  return messages.some(
    (message) => (message as Record<string, unknown> | undefined)?.["role"] === "tool",
  );
}

const TOOL_CALL_REQUESTS: Readonly<
  Record<string, { readonly name: string; readonly args: Record<string, unknown> }>
> = {
  "toolcall-danger": { name: "terminal", args: { command: "rm -rf /" } },
  "toolcall-safe": { name: "read_file", args: { path: "tool-target.txt" } },
};

function chatNonStream(
  response: ServerResponse,
  scenario: string,
  body: Record<string, unknown>,
): void {
  if (scenario === "err418") {
    json(response, errorPayload(), 418);
    return;
  }
  if (scenario === "midbreak") {
    // Round-1 Evaluator finding (F3): a non-stream upstream call reset
    // mid-body (chunked, no content-length declared upfront — matches how
    // the streaming midbreak mode already behaves) was previously
    // unexercised. `.write()` confirms the partial chunk left this
    // process's userspace buffer; the settle delay gives the OS time to
    // actually deliver it before the RST, same reasoning as the streaming
    // midbreak mode.
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"choices":[{"message":{"content":"partial', () => {
      setTimeout(() => response.socket?.destroy(), 300);
    });
    return;
  }
  const toolCall = TOOL_CALL_REQUESTS[scenario];
  if (toolCall !== undefined && !hasToolResult(body)) {
    json(response, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: USAGE,
    });
    return;
  }
  json(response, {
    choices: [
      {
        message: { content: `FAKE-UPSTREAM-OK:${scenario}` },
        finish_reason: scenario === "partial" ? "length" : "stop",
      },
    ],
    usage: scenario === "nousage" ? undefined : USAGE,
  });
}

function chatStream(
  response: ServerResponse,
  scenario: string,
  body: Record<string, unknown>,
): void {
  if (scenario === "err418") {
    json(response, errorPayload(), 418);
    return;
  }
  const deltaEvent = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
  const toolCall = TOOL_CALL_REQUESTS[scenario];
  if (toolCall !== undefined && !hasToolResult(body)) {
    const toolCallEvent = () =>
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`;
    const toolFinishEvent = () =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: USAGE })}\n\n`;
    sseFrames(response, [toolCallEvent(), toolFinishEvent()]);
    return;
  }
  const doneEvent = () =>
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: scenario === "partial" ? "length" : "stop" }],
      ...(scenario === "nousage" ? {} : { usage: USAGE }),
    })}\n\n`;
  if (scenario === "cleaneof") {
    // Protocol-clean chunked termination (a normal `.end()`, so Node emits
    // the correct closing "0\r\n\r\n" chunk): role/content deltas arrive,
    // then the connection just ends — no finish chunk, no [DONE]. The
    // client must treat this implicit EOF as partial success, not a
    // transport error (assertion 41).
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(deltaEvent(`FAKE-UPSTREAM-STREAM:${scenario}`));
    return;
  }
  if (scenario === "midbreak") {
    // Truncated mid-chunk: `.write()` still emits a well-formed chunk, but
    // destroying the socket instead of calling `.end()` means the overall
    // chunked body is missing its closing "0\r\n\r\n" terminator — a real
    // connection reset, not a clean EOF (assertion 49's "incomplete
    // chunked read"). The write's own callback only confirms the data left
    // this process's userspace buffer, not that the peer's TCP stack
    // received and delivered it to the client's HTTP parser before the
    // RST — an immediate destroy() in that callback still races the OS,
    // so a short setTimeout gives the bytes time to actually land before
    // the connection dies mid-chunk instead of before any chunk at all.
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(deltaEvent(`FAKE-UPSTREAM-STREAM:${scenario}`), () => {
      setTimeout(() => response.socket?.destroy(), 300);
    });
    return;
  }
  sseFrames(response, [deltaEvent(`FAKE-UPSTREAM-STREAM:${scenario}`), doneEvent()]);
}

export function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: UpstreamRequestRecord[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      const headers = Object.fromEntries(
        Object.entries(request.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]],
        ),
      );
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers,
        body,
        rawBody,
      });
      const scenario = scenarioOf(body);
      const stream = body["stream"] === true;
      if (stream) chatStream(response, scenario, body);
      else chatNonStream(response, scenario, body);
    });
  });
  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolveStart({
        url: `http://127.0.0.1:${String(port)}`,
        requests,
        close: () =>
          new Promise((resolveClose, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolveClose();
            });
          }),
      });
    });
  });
}
