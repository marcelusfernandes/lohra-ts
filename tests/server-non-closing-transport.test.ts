import { describe, expect, it } from "vitest";

import { NonClosingTransport } from "../src/server/non-closing-transport.js";
import type { ModelRequest } from "../src/conversation/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";

describe("NonClosingTransport", () => {
  it("delegates complete() to the wrapped transport", async () => {
    const response: NormalizedResponse = {
      content: "hi",
      finishReason: "stop",
      toolCalls: [],
      reasoning: null,
      usage: null,
      providerData: null,
    };
    let closed = 0;
    const inner = {
      complete: (_request: ModelRequest) => Promise.resolve(response),
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    };
    const wrapped = new NonClosingTransport(inner);

    const result = await wrapped.complete({} as ModelRequest);
    expect(result).toBe(response);

    wrapped.close();
    wrapped.close();
    expect(closed).toBe(0); // the shared client is never closed per-request
  });
});
