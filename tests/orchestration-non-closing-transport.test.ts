import { describe, expect, it } from "vitest";

import type { ModelRequest, ModelTransport } from "../src/conversation/index.js";
import { NonClosingTransport } from "../src/orchestration/non-closing-transport.js";
import type { NormalizedResponse } from "../src/transports/index.js";

const response: NormalizedResponse = {
  content: "hi",
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage: null,
  providerData: null,
};

class RecordingTransport implements ModelTransport {
  requests: ModelRequest[] = [];
  closes = 0;

  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(request);
    return Promise.resolve(response);
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }
}

describe("NonClosingTransport", () => {
  it("delegates complete() to the wrapped transport unchanged", async () => {
    const inner = new RecordingTransport();
    const wrapped = new NonClosingTransport(inner);
    const request = {} as ModelRequest;

    const result = await wrapped.complete(request);

    expect(result).toBe(response);
    expect(inner.requests).toEqual([request]);
  });

  it("never calls the wrapped transport's close() — the pool owns the underlying client's lifecycle", () => {
    const inner = new RecordingTransport();
    const wrapped = new NonClosingTransport(inner);

    wrapped.close();
    wrapped.close();

    expect(inner.closes).toBe(0);
  });
});
