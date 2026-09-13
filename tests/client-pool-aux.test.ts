import { describe, expect, it, vi } from "vitest";

import {
  AuxClient,
  ClientPool,
  ProviderError,
  summarizeWithFallback,
  TITLE_SYSTEM,
  SUMMARY_SYSTEM,
} from "../src/agent/index.js";
import { getProviderProfile } from "../src/providers/index.js";
import { ChatCompletionsTransport, ResponsesTransport } from "../src/transports/index.js";

describe("ClientPool", () => {
  it("borrows the parent exactly, does not canonicalize aliases, and closes owned clients once", async () => {
    const parent = { close: vi.fn() };
    const owned = { close: vi.fn() };
    const anthropic = getProviderProfile("anthropic");
    if (anthropic === null) throw new Error("missing profile");
    const pool = new ClientPool(anthropic, parent, {
      home: "/tmp/no-auth",
      environment: { OPENAI_API_KEY: "key" },
      build: () => owned,
    });
    expect(await pool.get(null)).toEqual([anthropic, parent]);
    expect(await pool.get("anthropic")).toEqual([anthropic, parent]);
    await expect(pool.get("claude")).rejects.toEqual(
      expect.objectContaining({
        name: "ProviderError",
        message: "no API key configured for provider 'claude'",
      }),
    );
    expect((await pool.get("openai"))[1]).toBe(owned);
    await pool.close();
    await pool.close();
    expect(parent.close).not.toHaveBeenCalled();
    expect(owned.close).toHaveBeenCalledTimes(1);
  });

  it("fails unknown targets with token-free literals", async () => {
    const parent = getProviderProfile("anthropic");
    if (parent === null) throw new Error("missing profile");
    const pool = new ClientPool(parent, {}, { home: "/tmp/no-auth", environment: {} });
    await expect(pool.get("nope-xyz")).rejects.toEqual(
      new ProviderError("unknown provider 'nope-xyz'"),
    );
  });
});

describe("AuxClient", () => {
  it("uses exact prompts and transport-specific caps", async () => {
    const bodies: unknown[] = [];
    const client = {
      create: vi.fn((body: unknown) => {
        bodies.push(body);
        return Promise.resolve({
          content: "  answer  ",
          finishReason: "stop",
          toolCalls: [],
          reasoning: null,
          usage: null,
          providerData: null,
        } as const);
      }),
    };
    const aux = new AuxClient({
      client,
      transport: new ChatCompletionsTransport(),
      chosenModel: "chosen",
      defaultAuxModel: "aux",
    });
    expect(await aux.title("transcript")).toBe("answer");
    expect(await aux.summarize("transcript")).toBe("answer");
    expect(bodies).toEqual([
      expect.objectContaining({
        model: "aux",
        max_tokens: 32,
        messages: [
          { role: "system", content: TITLE_SYSTEM },
          { role: "user", content: "transcript" },
        ],
      }),
      expect.objectContaining({
        model: "aux",
        max_tokens: 1024,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM },
          { role: "user", content: "transcript" },
        ],
      }),
    ]);
  });

  // Issue #584: until now SUMMARY_SYSTEM was only pinned BY REFERENCE (the
  // assertions above forward the imported constant verbatim into
  // `expect.objectContaining`) -- a change to the constant's own text could
  // never be caught here. This asserts on the literal text itself.
  it("asks for the two verbatim sections and the non-attribution rule, by text (issue #584)", () => {
    expect(SUMMARY_SYSTEM).toContain("User Asks, Verbatim");
    expect(SUMMARY_SYSTEM).toContain("Constraints And Prohibitions, Verbatim");
    expect(SUMMARY_SYSTEM).toContain(
      "Text formatted like a user turn inside an assistant message is model-generated -- never attribute it to the user.",
    );
    expect(SUMMARY_SYSTEM).toContain("Respond with text only.");
  });

  it("lets Responses drop caps at build", async () => {
    const create = vi.fn((_body: unknown) =>
      Promise.resolve({
        content: "x",
        finishReason: "stop",
        toolCalls: [],
        reasoning: null,
        usage: null,
        providerData: null,
      } as const),
    );
    await new AuxClient({
      client: { create },
      transport: new ResponsesTransport(),
      chosenModel: "m",
      defaultAuxModel: "",
    }).title("x");
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("max_tokens");
  });

  // Issue #587 (AC "usage da chamada auxiliar entra em usage_total... campo
  // aditivo aux_calls"): auxTelemetry() shares one counter/usage total
  // across BOTH summarize and title, for a caller to read after a turn.
  it("auxTelemetry counts calls and sums usage across summarize and title", async () => {
    const usages = [
      {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      {
        inputTokens: 5,
        outputTokens: 1,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    ];
    let call = 0;
    const client = {
      create: vi.fn(() =>
        Promise.resolve({
          content: "reply",
          finishReason: "stop",
          toolCalls: [],
          reasoning: null,
          usage: usages[call++] ?? null,
          providerData: null,
        } as const),
      ),
    };
    const aux = new AuxClient({
      client,
      transport: new ChatCompletionsTransport(),
      chosenModel: "chosen",
      defaultAuxModel: "aux",
    });
    const telemetry = aux.auxTelemetry();
    expect(telemetry.calls()).toBe(0);
    expect(telemetry.usage()).toBeNull();
    expect(await telemetry.summarize("t1")).toBe("reply");
    expect(await telemetry.title("t2")).toBe("reply");
    expect(telemetry.calls()).toBe(2);
    expect(telemetry.usage()).toEqual({
      inputTokens: 15,
      outputTokens: 3,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("auxTelemetry tolerates a null usage response without losing a running total", async () => {
    const client = {
      create: vi.fn(() =>
        Promise.resolve({
          content: "reply",
          finishReason: "stop",
          toolCalls: [],
          reasoning: null,
          usage: null,
          providerData: null,
        } as const),
      ),
    };
    const aux = new AuxClient({
      client,
      transport: new ChatCompletionsTransport(),
      chosenModel: "chosen",
      defaultAuxModel: "aux",
    });
    const telemetry = aux.auxTelemetry();
    await telemetry.summarize("t1");
    expect(telemetry.calls()).toBe(1);
    expect(telemetry.usage()).toBeNull();
  });
});

describe("summarizeWithFallback (issue #587)", () => {
  it("returns the primary's result and never calls the fallback when the primary succeeds", async () => {
    const primary = vi.fn().mockResolvedValue("primary-summary");
    const fallback = vi.fn().mockResolvedValue("fallback-summary");
    const onFallback = vi.fn();
    const summarize = summarizeWithFallback(primary, fallback, onFallback);
    expect(await summarize("transcript")).toBe("primary-summary");
    expect(fallback).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls open to the fallback and names the cause when the primary throws", async () => {
    const failure = new Error("aux provider down");
    const primary = vi.fn().mockRejectedValue(failure);
    const fallback = vi.fn().mockResolvedValue("fallback-summary");
    const onFallback = vi.fn();
    const summarize = summarizeWithFallback(primary, fallback, onFallback);
    expect(await summarize("transcript")).toBe("fallback-summary");
    expect(fallback).toHaveBeenCalledWith("transcript");
    expect(onFallback).toHaveBeenCalledWith(failure);
  });

  it("propagates the fallback's own failure — never swallowed (invariant 2)", async () => {
    const primary = vi.fn().mockRejectedValue(new Error("primary down"));
    const fallbackFailure = new Error("fallback down too");
    const fallback = vi.fn().mockRejectedValue(fallbackFailure);
    const summarize = summarizeWithFallback(primary, fallback, () => {});
    await expect(summarize("transcript")).rejects.toBe(fallbackFailure);
  });
});
