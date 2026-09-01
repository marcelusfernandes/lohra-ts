import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPinnedConnector } from "../src/web/index.js";
import type { ConnectorResponse } from "../src/web/index.js";
import { EventEmitter } from "node:events";

interface FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress: string | null };
  chunks: Buffer[];
  read(): Buffer | null;
  destroy(): void;
  readableEnded: boolean;
}

interface FakeRequest extends EventEmitter {
  end(body?: string): void;
  destroy(): void;
}

interface RecordedExchange {
  options: Record<string, unknown>;
  request: FakeRequest;
  response: FakeResponse;
  chunks: Buffer[];
}

type FakeFactory = (
  secure: boolean,
) => (options: Record<string, unknown>, callback: (response: FakeResponse) => void) => FakeRequest;

function makeLayer(exchanges: RecordedExchange[]): FakeFactory {
  return (secure: boolean) => (options, callback) => {
    const request: FakeRequest = new EventEmitter() as FakeRequest;
    const response: FakeResponse = new EventEmitter() as FakeResponse;
    const record: RecordedExchange = { options, request, response, chunks: [] };
    void response;
    response.statusCode = 200;
    response.headers = { "content-type": "text/plain" };
    response.socket = { remoteAddress: "93.184.216.34" };
    response.chunks = record.chunks;
    response.readableEnded = false;
    response.read = () => {
      const chunk = record.chunks.shift() ?? null;
      return chunk;
    };
    response.destroy = () => {
      response.removeAllListeners();
    };
    request.end = () => {
      exchanges.push(record);
      callback(response);
    };
    request.destroy = () => {
      request.removeAllListeners();
      response.destroy();
    };
    void secure;
    return request;
  };
}

describe("nodeDial lifecycle over an in-memory http layer", () => {
  let exchanges: RecordedExchange[];
  let factory: FakeFactory;

  beforeEach(() => {
    exchanges = [];
    factory = makeLayer(exchanges);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function dial(requestFactory: FakeFactory, lookup?: (host: string, opts: unknown, cb: (err: Error | null, address?: string, family?: number) => void) => void): Promise<ConnectorResponse> {
    const connector = createPinnedConnector({
      requestFactory,
      ...(lookup === undefined ? {} : { lookup }),
    });
    return connector.request({
      url: "https://public.test/a",
      method: "GET",
      headers: { "user-agent": "fixture" },
      allowedAddresses: [{ address: "93.184.216.34", family: 4 }],
      hostname: "public.test",
      timeoutSeconds: 10,
      deadlineMs: 10_000,
    });
  }

  it("keeps the timeout armed after headers and destroys a stalled body at the deadline", async () => {
    let settled: { error?: Error; done?: boolean } = {};
    const pending = dial(factory).then(
      (response) => {
        const next = response.stream.next();
        return next.then(
          () => ({ done: true }),
          (error: Error) => ({ error }),
        );
      },
      (error: Error) => ({ error }),
    );
    pending.then((value) => {
      settled = value;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    expect((settled.error as Error | undefined)?.message).toBe(
      "request timed out after 10 seconds",
    );
  });

  it("rejects a response error with the preserved cause and releases listeners", async () => {
    const pending = dial(factory);
    await vi.advanceTimersByTimeAsync(0);
    const response = exchanges[0]?.response;
    if (response === undefined) throw new Error("fixture response missing");
    const settled = pending.then(
      (value) => value.stream.next().then(() => "done", (error: Error) => error.message),
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(0);
    response.emit("error", new Error("fixture stream aborted"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toBe("fixture stream aborted");
    expect(response.listenerCount("readable")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
  });

  it("rejects an aborted response before any body byte", async () => {
    const pending = dial(factory);
    await vi.advanceTimersByTimeAsync(0);
    const response = exchanges[0]?.response;
    if (response === undefined) throw new Error("fixture response missing");
    const settled = pending.then(
      (value) => value.stream.next().then(() => "done", (error: Error) => error.message),
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(0);
    response.emit("aborted");
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toBe("response aborted");
    expect(response.listenerCount("aborted")).toBe(0);
  });

  it("rejects a premature close without end", async () => {
    const pending = dial(factory);
    await vi.advanceTimersByTimeAsync(0);
    const response = exchanges[0]?.response;
    if (response === undefined) throw new Error("fixture response missing");
    const settled = pending.then(
      (value) => value.stream.next().then(() => "done", (error: Error) => error.message),
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(0);
    response.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toBe("response closed before completion");
    expect(response.listenerCount("close")).toBe(0);
  });

  it("cleans listeners and timer after a completed body", async () => {
    const pending = dial(factory);
    await vi.advanceTimersByTimeAsync(0);
    const response = exchanges[0]?.response;
    if (response === undefined) throw new Error("fixture response missing");
    response.chunks.push(Buffer.from("partial"));
    const first = await pending;
    const firstChunk = await first.stream.next();
    expect(firstChunk.done).toBe(false);
    const second = first.stream.next();
    response.emit("end");
    const done = await second;
    expect(done.done).toBe(true);
    expect(response.listenerCount("readable")).toBe(0);
    expect(response.listenerCount("end")).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
  });

  it("passes the pinned address as host, TLS verification on, and never re-resolves", async () => {
    const lookupCalls: string[] = [];
    const lookup = (host: string, _opts: unknown, cb: (err: Error | null) => void): void => {
      lookupCalls.push(host);
      cb(null);
    };
    const pending = dial(factory, lookup);
    await vi.advanceTimersByTimeAsync(0);
    await pending.then(
      (value) => value.stream.cancel(),
      () => {},
    );
    expect(lookupCalls).toEqual([]);
    const options = exchanges[0]?.options as {
      host: string;
      port: number;
      rejectUnauthorized: boolean;
      servername: string;
      path: string;
      method: string;
    };
    expect(options.host).toBe("93.184.216.34");
    expect(options.port).toBe(443);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.servername).toBe("public.test");
    expect(options.method).toBe("GET");
    expect(options.path).toBe("/a");
  });

  it("surfaces a 3xx as-is so redirects are never followed automatically", async () => {
    const connector = createPinnedConnector({
      requestFactory: () => (options, callback) => {
        const request = new EventEmitter() as unknown as FakeRequest;
        const response = new EventEmitter() as unknown as FakeResponse;
        response.statusCode = 302;
        response.headers = { location: "http://private.test/" };
        response.socket = { remoteAddress: "93.184.216.34" };
        response.readableEnded = false;
        response.read = () => null;
        response.destroy = () => response.removeAllListeners();
        request.end = () => {
          callback(response);
        };
        request.destroy = () => {
          request.removeAllListeners();
          response.destroy();
        };
        void options;
        return request;
      },
    });
    const settled = await connector.request({
      url: "https://public.test/a",
      method: "GET",
      headers: {},
      allowedAddresses: [{ address: "93.184.216.34", family: 4 }],
      hostname: "public.test",
      timeoutSeconds: 10,
      deadlineMs: 10_000,
    });
    expect(settled.status).toBe(302);
    expect(settled.headers.location).toBe("http://private.test/");
    await settled.stream.cancel();
  });
});
