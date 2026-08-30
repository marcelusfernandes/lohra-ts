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
        .map((part) => (typeof part === "object" && part !== null ? (part as Record<string, unknown>)["text"] : ""))
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

function chatNonStream(response: ServerResponse, scenario: string): void {
  if (scenario === "err418") {
    json(
      response,
      { error: { message: "T11_CAUSE_CANARY upstream refused", type: "teapot_error" } },
      418,
    );
    return;
  }
  json(response, {
    choices: [{ message: { content: `FAKE-UPSTREAM-OK:${scenario}` }, finish_reason: "stop" }],
    usage: scenario === "nousage" ? undefined : USAGE,
  });
}

function chatStream(response: ServerResponse, scenario: string): void {
  if (scenario === "err418") {
    json(
      response,
      { error: { message: "T11_CAUSE_CANARY upstream refused", type: "teapot_error" } },
      418,
    );
    return;
  }
  const deltaEvent = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
  const doneEvent = () =>
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(scenario === "nousage" ? {} : { usage: USAGE }),
    })}\n\n`;
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
      requests.push({ method: request.method ?? "", path: request.url ?? "", headers, body, rawBody });
      const scenario = scenarioOf(body);
      const stream = body["stream"] === true;
      if (stream) chatStream(response, scenario);
      else chatNonStream(response, scenario);
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
