import net from "node:net";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { ChatCompletionsModel } from "../src/conversation/index.js";
import { createOpenAiServer } from "../src/server/http-app.js";
import { CompletionService } from "../src/server/service.js";
import { ChatCompletionsClient, ChatCompletionsTransport } from "../src/transports/index.js";

/** A raw fake upstream: two SSE content-delta chunks, then a graceful
 * chunked-transfer close (proper 0-length terminator) with NO finish_reason
 * chunk and no [DONE] — the exact "clean EOF" shape contract v2 assertions
 * 41/50 require the candidate to treat as a partial SUCCESS, not a failure. */
function startCleanEofUpstream(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        if (!buffered.includes("\r\n\r\n")) return;
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
        );
        const frame = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        const chunks = [
          frame({
            id: "chatcmpl-fake",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          }),
          frame({
            id: "chatcmpl-fake",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
          }),
        ];
        for (const text of chunks) {
          socket.write(`${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`);
        }
        // Proper chunked-encoding terminator: a GRACEFUL end, not a reset.
        socket.end("0\r\n\r\n");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

function dechunk(buffer: Buffer): string {
  let offset = 0;
  let out = "";
  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString("ascii").trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const dataStart = lineEnd + 2;
    out += buffer.subarray(dataStart, dataStart + size).toString("utf8");
    offset = dataStart + size + 2;
  }
  return out;
}

/** Sends a raw request and returns just the dechunked SSE body (the response
 * headers/status are not this test's concern — server-http-app.test.ts
 * already covers those). */
function sendRaw(port: number, requestLines: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(requestLines.replaceAll("\n", "\r\n") + "\r\n" + body);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const headerEnd = raw.indexOf("\r\n\r\n");
      resolve(dechunk(raw.subarray(headerEnd + 4)));
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, 5000);
  });
}

describe("clean EOF on a pure-text upstream stream (assertion 41)", () => {
  let upstreamClose: (() => void) | undefined;
  let httpServer: Server | undefined;

  afterEach(() => {
    upstreamClose?.();
    httpServer?.close();
  });

  it("ends the chat SSE stream with finish stop, an estimated usage chunk, and [DONE] — not an error", async () => {
    const upstream = await startCleanEofUpstream();
    upstreamClose = upstream.close;

    const client = new ChatCompletionsClient({
      baseUrl: `http://127.0.0.1:${String(upstream.port)}`,
      apiKey: "fake-key",
      transport: new ChatCompletionsTransport(),
    });
    const model = new ChatCompletionsModel(client, false);
    const streamingModel = new ChatCompletionsModel(client, true);
    const service = new CompletionService({
      transport: model,
      streamingTransport: streamingModel,
      systemPrompt: () => "system",
      provider: "fakeprov",
      maxIterations: 8,
      defaultMaxTokens: 8192,
    });
    httpServer = createOpenAiServer({ service, apiKey: "test-key", models: ["m"] });
    const port = await new Promise<number>((resolve) => {
      httpServer?.listen(0, "127.0.0.1", () => {
        const address = httpServer?.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    const body = JSON.stringify({
      model: "m",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    });
    const raw = await sendRaw(
      port,
      `POST /v1/chat/completions HTTP/1.1\nHost: 127.0.0.1\nAuthorization: Bearer test-key\nContent-Type: application/json\nContent-Length: ${String(Buffer.byteLength(body))}\nConnection: close\n`,
      body,
    );

    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const dataLines = raw
      .split("\n\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

    const contentDeltas = dataLines
      .map((d) => (d["choices"] as { delta: Record<string, unknown> }[])[0]?.delta["content"])
      .filter((v): v is string => typeof v === "string")
      .join("");
    expect(contentDeltas).toBe("partial");

    const finishFrame = dataLines.find(
      (d) => ((d["choices"] as { finish_reason: string | null }[] | undefined)?.[0]?.finish_reason ?? null) !== null,
    );
    expect((finishFrame?.["choices"] as { finish_reason: string }[])[0]?.finish_reason).toBe("stop");

    const usageFrame = dataLines.find((d) => "usage" in d);
    expect(usageFrame).toBeDefined();
    const usage = usageFrame?.["usage"] as { prompt_tokens: number; completion_tokens: number };
    expect(usage.completion_tokens).toBeGreaterThan(0); // estimated, not upstream-reported (which was null)
  });
});
