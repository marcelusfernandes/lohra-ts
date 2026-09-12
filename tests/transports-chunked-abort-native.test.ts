import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ChatCompletionsClient, ChatCompletionsTransport } from "../src/transports/index.js";

/** A raw TCP server that sends ONE valid content-delta chunk and then HOLDS
 * the socket open (never destroys it, never sends the terminating 0-length
 * chunk) — an in-flight stream that would otherwise run forever, matching
 * ADR 0005's precondition: the transport itself never faults, only the
 * caller's `AbortSignal` ends the call. Molded on
 * `transports-chunked-truncation-partial-delta.test.ts`'s
 * `startTruncatingServerAfterDelta`, minus the `socket.destroy()`. */
function startHoldingServerAfterDelta(): {
  port: Promise<number>;
  close: () => void;
} {
  let socket: net.Socket | undefined;
  const server = net.createServer((connection) => {
    socket = connection;
    connection.on("data", () => {
      connection.write(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
      );
      const chunk =
        'data: {"id":"chatcmpl-fake","choices":[{"index":0,"delta":{"content":"partial-before-abort"},"finish_reason":null}]}\n\n';
      connection.write(`${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`);
    });
  });
  const port = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return {
    port,
    close: () => {
      socket?.destroy();
      server.close();
    },
  };
}

describe("ChatCompletionsClient.stream — native abort in flight (ADR 0005)", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  it("rejects with StreamAbortedError carrying the partial bytes — a single rejection reason, never 'incomplete chunked read'", async () => {
    const { StreamAbortedError } = await import("../src/transports/index.js");
    const server = startHoldingServerAfterDelta();
    close = server.close;
    const port = await server.port;
    const client = new ChatCompletionsClient({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: "fake-key",
      transport: new ChatCompletionsTransport(),
    });

    const controller = new AbortController();
    const received: string[] = [];
    const pending = client.stream(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { onText: (text) => received.push(text) },
      controller.signal,
    );

    // Give the one chunk time to actually reach the client's HTTP parser
    // (matches `startTruncatingServerAfterDelta`'s own precondition) before
    // the abort tears the connection down.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort(new Error("USER_CANCELLED"));

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StreamAbortedError);
    expect((error as Error).name).toBe("StreamAbortedError");
    expect((error as Error).message).not.toMatch(/incomplete chunked read/u);
    expect(received.join("")).toBe("partial-before-abort");
    const partial = (error as InstanceType<typeof StreamAbortedError>).partial;
    expect(partial.text).toBe("partial-before-abort");
  });
});
