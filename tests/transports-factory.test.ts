import { describe, expect, it } from "vitest";

import { listProviders } from "../src/providers/index.js";
import { resolveChatCompletionsTarget } from "../src/transports/index.js";

describe("resolveChatCompletionsTarget", () => {
  it("routes every chat-completions provider through the same boundary", () => {
    const environment = Object.fromEntries(
      listProviders().flatMap((profile) =>
        profile.envVars.map((name) => [name, `${profile.name}-key`]),
      ),
    );
    const names = listProviders()
      .filter((profile) => profile.apiMode === "chat_completions")
      .map((profile) => resolveChatCompletionsTarget(profile.name, environment).profile.name);
    expect(names).toEqual([
      "openai",
      "openrouter",
      "deepseek",
      "groq",
      "together",
      "gemini",
      "xai",
      "glm",
      "kimi",
      "ollama",
    ]);
  });

  it("canonicalizes aliases, rejects Anthropic, and supplies the Ollama placeholder", () => {
    expect(resolveChatCompletionsTarget("OR", { OPENROUTER_API_KEY: "k" })).toMatchObject({
      profile: { name: "openrouter" },
      apiKey: "k",
    });
    expect(resolveChatCompletionsTarget("ollama", {})).toMatchObject({ apiKey: "lohra-local" });
    expect(() => resolveChatCompletionsTarget("anthropic", { ANTHROPIC_API_KEY: "k" })).toThrow(
      "UNSUPPORTED_API_MODE",
    );
  });
});
