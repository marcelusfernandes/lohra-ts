import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createOpenAiServer } from "../src/server/http-app.js";
import { CompletionService } from "../src/server/service.js";
import type { ModelRequest, ModelTransport } from "../src/conversation/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";
import type { Server } from "node:http";

interface RawResponse {
  readonly statusLine: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function dechunk(buffer: Buffer): string {
  let offset = 0;
  let out = "";
  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const sizeHex = buffer.subarray(offset, lineEnd).toString("ascii").trim();
    const size = Number.parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size === 0) break;
    const dataStart = lineEnd + 2;
    out += buffer.subarray(dataStart, dataStart + size).toString("utf8");
    offset = dataStart + size + 2;
  }
  return out;
}

function sendRaw(port: number, requestLines: string, body = ""): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(requestLines.replaceAll("\n", "\r\n") + "\r\n" + body);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const headerEnd = raw.indexOf("\r\n\r\n");
      const headerText = raw.subarray(0, headerEnd).toString("utf8");
      const bodyRaw = raw.subarray(headerEnd + 4);
      const [statusLine, ...headerLines] = headerText.split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const index = line.indexOf(":");
        headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
      }
      const body =
        headers["transfer-encoding"] === "chunked" ? dechunk(bodyRaw) : bodyRaw.toString("utf8");
      resolve({ statusLine: statusLine ?? "", headers, body });
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    }, 5000);
  });
}

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

class ScriptedTransport implements ModelTransport {
  constructor(private readonly next: (request: ModelRequest) => NormalizedResponse) {}

  complete(request: ModelRequest): Promise<NormalizedResponse> {
    const response = this.next(request);
    if (response === UPSTREAM_FAILS) return Promise.reject(new Error("upstream unreachable"));
    return Promise.resolve(response);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const UPSTREAM_FAILS = Symbol("fails") as unknown as NormalizedResponse;

function okResponse(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    content: "hello",
    finishReason: "stop",
    toolCalls: [],
    reasoning: null,
    usage,
    providerData: null,
    ...overrides,
  };
}

describe("createOpenAiServer — end-to-end HTTP/SSE wiring", () => {
  let server: Server;
  let port: number;

  function start(transportResult: (request: ModelRequest) => NormalizedResponse, apiKey: string | null = "test-key") {
    const service = new CompletionService({
      transport: new ScriptedTransport(transportResult),
      streamingTransport: new ScriptedTransport(transportResult),
      systemPrompt: () => "system",
      provider: "ollama",
      maxIterations: 8,
      defaultMaxTokens: 8192,
    });
    server = createOpenAiServer({ service, apiKey, models: ["fake-model-a", "fake-model-b"] });
    return new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        port = typeof address === "object" && address !== null ? address.port : 0;
        resolve();
      });
    });
  }

  afterEach(() => {
    server.close();
  });

  it("GET /health ignores auth and returns the compact byte-exact body", async () => {
    await start(() => okResponse());
    const res = await sendRaw(port, "GET /health HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n");
    expect(res.statusLine).toBe("HTTP/1.1 200 OK");
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["transfer-encoding"]).toBeUndefined();
    expect(res.body).toBe('{"ok":true,"version":"0.0.11"}');
  });

  it("HEAD /health is 405 (no auto-HEAD support)", async () => {
    await start(() => okResponse());
    const res = await sendRaw(port, "HEAD /health HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n");
    expect(res.statusLine).toBe("HTTP/1.1 405 Method Not Allowed");
  });

  it("GET /v1/runs is 404 and GET / is 404", async () => {
    await start(() => okResponse());
    for (const path of ["/v1/runs", "/"]) {
      const res = await sendRaw(port, `GET ${path} HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n`);
      expect(res.statusLine).toBe("HTTP/1.1 404 Not Found");
      expect(res.body).toBe('{"detail":"Not Found"}');
    }
  });

  it("trailing slash on a known path 307s with an absolute Location from Host", async () => {
    await start(() => okResponse());
    const res = await sendRaw(
      port,
      "GET /v1/chat/completions/ HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n",
    );
    expect(res.statusLine).toBe("HTTP/1.1 307 Temporary Redirect");
    expect(res.headers["location"]).toBe("http://127.0.0.1/v1/chat/completions");
    expect(res.headers["content-length"]).toBe("0");
  });

  it("GET /v1/models requires auth and lists the configured models", async () => {
    await start(() => okResponse());
    const unauth = await sendRaw(port, "GET /v1/models HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n");
    expect(unauth.statusLine).toBe("HTTP/1.1 401 Unauthorized");

    const authed = await sendRaw(
      port,
      "GET /v1/models HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer test-key\nConnection: close\n",
    );
    expect(authed.statusLine).toBe("HTTP/1.1 200 OK");
    const parsed = JSON.parse(authed.body) as { data: { id: string }[] };
    expect(parsed.data.map((m) => m.id)).toEqual(["fake-model-a", "fake-model-b"]);
  });

  it("--insecure mode (apiKey null) accepts requests with no Authorization header", async () => {
    await start(() => okResponse(), null);
    const res = await sendRaw(port, "GET /v1/models HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n");
    expect(res.statusLine).toBe("HTTP/1.1 200 OK");
  });

  it("body validation precedes auth: missing model + no auth is 422, not 401", async () => {
    await start(() => okResponse());
    const body = JSON.stringify({ messages: [{ role: "user", content: "x" }] });
    const res = await sendRaw(
      port,
      `POST /v1/chat/completions HTTP/1.1\nHost: 127.0.0.1\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );
    expect(res.statusLine).toBe("HTTP/1.1 422 Unprocessable Entity");
  });

  it("valid body + no auth is 401", async () => {
    await start(() => okResponse());
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] });
    const res = await sendRaw(
      port,
      `POST /v1/chat/completions HTTP/1.1\nHost: 127.0.0.1\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );
    expect(res.statusLine).toBe("HTTP/1.1 401 Unauthorized");
  });

  it("auth valid + empty messages is 400 before any upstream call", async () => {
    let called = false;
    await start(() => {
      called = true;
      return okResponse();
    });
    const body = JSON.stringify({ model: "m", messages: [] });
    const res = await sendRaw(
      port,
      `POST /v1/chat/completions HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer test-key\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );
    expect(res.statusLine).toBe("HTTP/1.1 400 Bad Request");
    expect(JSON.parse(res.body)).toEqual({
      error: { message: "'messages' must not be empty", type: "invalid_request_error" },
    });
    expect(called).toBe(false);
  });

  it("non-stream chat success: content-length present, no transfer-encoding, compact body", async () => {
    await start(() => okResponse({ content: "hi there" }));
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const res = await sendRaw(
      port,
      `POST /v1/chat/completions HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer test-key\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );
    expect(res.statusLine).toBe("HTTP/1.1 200 OK");
    expect(res.headers["content-length"]).toBeDefined();
    expect(res.headers["transfer-encoding"]).toBeUndefined();
    const parsed = JSON.parse(res.body) as { choices: { message: { content: string } }[] };
    expect(parsed.choices[0]?.message.content).toBe("hi there");
    expect(res.body.includes(", ")).toBe(false); // compact, no spaces
  });

  it("chat SSE success: role chunk, content deltas, finish chunk, [DONE], chunked transfer", async () => {
    await start((request) => {
      request.onText?.("he");
      request.onText?.("llo");
      return okResponse({ content: "hello" });
    });
    const body = JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = await sendRaw(
      port,
      `POST /v1/chat/completions HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer test-key\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );
    expect(res.statusLine).toBe("HTTP/1.1 200 OK");
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(res.headers["transfer-encoding"]).toBe("chunked");
    expect(res.headers["content-length"]).toBeUndefined();

    const frames = res.body.split("\n\n").filter((f) => f.length > 0);
    expect(frames[frames.length - 1]).toBe("data: [DONE]");
    const dataFrames = frames.filter((f) => f !== "data: [DONE]").map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
    expect((dataFrames[0]?.["choices"] as { delta: Record<string, unknown> }[])[0]?.delta).toEqual({
      role: "assistant",
    });
    const text = dataFrames
      .slice(1, -1)
      .map((frame) => (frame["choices"] as { delta: Record<string, unknown> }[])[0]?.delta["content"])
      .join("");
    expect(text).toBe("hello");
    const last = dataFrames[dataFrames.length - 1] as { choices: { finish_reason: string }[] };
    expect(last.choices[0]?.finish_reason).toBe("stop");
  });

  it("upstream failure: non-stream chat is 502 with upstream_error and the causal message", async () => {
    await start(() => UPSTREAM_FAILS);
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const res = await sendRaw(
      port,
      `POST /v1/chat/completions HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer test-key\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );
    expect(res.statusLine).toBe("HTTP/1.1 502 Bad Gateway");
    const parsed = JSON.parse(res.body) as { error: { type: string; message: string } };
    expect(parsed.error.type).toBe("upstream_error");
    expect(parsed.error.message).toContain("upstream unreachable");
  });

  it("upstream failure mid-SSE keeps the role chunk, emits an error frame, still ends in [DONE]", async () => {
    await start(() => UPSTREAM_FAILS);
    const body = JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = await sendRaw(
      port,
      `POST /v1/chat/completions HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer test-key\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );
    const frames = res.body.split("\n\n").filter((f) => f.length > 0);
    expect(frames[0]).toContain('"role": "assistant"');
    expect(frames[frames.length - 1]).toBe("data: [DONE]");
    const errorFrame = frames.find((f) => f.includes('"error"'));
    expect(errorFrame).toBeDefined();
    expect(JSON.parse(errorFrame?.slice(6) ?? "{}")).toMatchObject({
      error: { type: "upstream_error" },
    });
  });

  it("Responses non-stream success has the 16-field shape", async () => {
    await start(() => okResponse({ content: "answer" }));
    const body = JSON.stringify({ model: "m", input: "hi" });
    const res = await sendRaw(
      port,
      `POST /v1/responses HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer test-key\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );
    expect(res.statusLine).toBe("HTTP/1.1 200 OK");
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["output_text"]).toBe("answer");
    expect(parsed["status"]).toBe("completed");
    // full byte-exact shape is verified against the measured fixture in
    // tests/server-responses-format.test.ts; here we just check wiring.
    expect(parsed["id"]).toMatch(/^resp_[0-9a-f]{32}$/u);
  });

  it("Responses SSE success never emits [DONE] and ends on response.completed", async () => {
    await start((request) => {
      request.onText?.("par");
      request.onText?.("tial");
      return okResponse({ content: "partial" });
    });
    const body = JSON.stringify({ model: "m", stream: true, input: "hi" });
    const res = await sendRaw(
      port,
      `POST /v1/responses HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer test-key\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );
    expect(res.body).not.toContain("[DONE]");
    const eventTypes = [...res.body.matchAll(/event: ([^\n]+)/gu)].map((m) => m[1]);
    expect(eventTypes).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.completed",
    ]);
  });

  it("Responses SSE upstream failure ends on response.failed, no [DONE]", async () => {
    await start(() => UPSTREAM_FAILS);
    const body = JSON.stringify({ model: "m", stream: true, input: "hi" });
    const res = await sendRaw(
      port,
      `POST /v1/responses HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer test-key\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );
    expect(res.body).not.toContain("[DONE]");
    expect(res.body).toContain("event: response.failed");
    expect(res.body).toContain('"output": []');
  });
});
