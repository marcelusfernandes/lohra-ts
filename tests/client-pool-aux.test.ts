import { describe, expect, it, vi } from "vitest";

import {
  AuxClient,
  ClientPool,
  ProviderError,
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
});
