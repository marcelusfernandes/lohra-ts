import { describe, expect, it } from "vitest";

import { ProviderCallFailed, publicCauseMessage } from "../src/transports/index.js";

describe("publicCauseMessage", () => {
  it("builds the SDK-style 'Error code: N - {...}' form from a ProviderCallFailed cause", () => {
    const cause = new ProviderCallFailed("upstream refused", {
      statusCode: 418,
      payload: { error: { message: "T11_CAUSE_NONCE42 upstream refused", type: "teapot_error" } },
    });
    const error = new Error("wrapped", { cause });
    expect(publicCauseMessage(error)).toBe(
      "Error code: 418 - {'error': {'message': 'T11_CAUSE_NONCE42 upstream refused', 'type': 'teapot_error'}}",
    );
  });

  it("falls back to the error's own message without a ProviderCallFailed cause", () => {
    expect(publicCauseMessage(new Error("boom"))).toBe("boom");
    expect(publicCauseMessage("not an error")).toBe("not an error");
  });

  it("falls back when the ProviderCallFailed cause has no status code", () => {
    const cause = new ProviderCallFailed("network reset");
    const error = new Error("wrapped", { cause });
    expect(publicCauseMessage(error)).toBe("wrapped");
  });
});
