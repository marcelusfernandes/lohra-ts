import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { NativeChatHttpPort } from "../src/transports/index.js";

/** A raw TCP server that starts a chunked response, sends one valid chunk,
 * then destroys the socket without the terminating 0-length chunk — a
 * connection reset mid-body, distinct from a graceful close after the last
 * chunk (clean EOF, which is a separate, non-error path). */
function startTruncatingServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
        );
        const chunk = 'data: {"partial":true}\n\n';
        socket.write(`${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`);
        setTimeout(() => socket.destroy(), 30);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe("NativeChatHttpPort — chunked mid-stream truncation", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  it("rejects with a message containing 'incomplete chunked read', not the raw 'aborted'", async () => {
    const server = await startTruncatingServer();
    close = server.close;
    const http = new NativeChatHttpPort();

    await expect(
      http.post({
        url: `http://127.0.0.1:${String(server.port)}/`,
        headers: {},
        body: "{}",
        timeoutMs: 5000,
        maxBytes: 4_000_000,
      }),
    ).rejects.toThrow(/incomplete chunked read/u);
  });
});
