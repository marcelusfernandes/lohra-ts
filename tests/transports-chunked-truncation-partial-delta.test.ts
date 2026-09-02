import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ChatCompletionsClient, ChatCompletionsTransport } from "../src/transports/index.js";

/** A raw TCP server that sends ONE valid content-delta chunk, waits long
 * enough for it to actually reach the client's HTTP parser (a write()
 * callback alone only confirms it left this process's userspace buffer,
 * not that the peer received it), then destroys the socket without the
 * terminating 0-length chunk — a connection reset mid-body, after a
 * partial delta, matching contract-t11 assertion 49's precondition
 * ("quebra de transporte após delta parcial"). */
function startTruncatingServerAfterDelta(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
        );
        const chunk =
          'data: {"id":"chatcmpl-fake","choices":[{"index":0,"delta":{"content":"partial-before-break"},"finish_reason":null}]}\n\n';
        socket.write(`${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`, () => {
          setTimeout(() => socket.destroy(), 100);
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe("ChatCompletionsClient.stream — mid-body truncation after a partial delta", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  it("delivers the already-received delta via onText before rejecting (assertion 49)", async () => {
    const server = await startTruncatingServerAfterDelta();
    close = server.close;
    const client = new ChatCompletionsClient({
      baseUrl: `http://127.0.0.1:${String(server.port)}`,
      apiKey: "fake-key",
      transport: new ChatCompletionsTransport(),
    });

    const received: string[] = [];
    await expect(
      client.stream(
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        { onText: (text) => received.push(text) },
      ),
    ).rejects.toThrow(/incomplete chunked read/u);

    expect(received.join("")).toBe("partial-before-break");
  });
});
