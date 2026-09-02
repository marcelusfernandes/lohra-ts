import { describe, expect, it } from "vitest";

import {
  CODEX_PROVIDER,
  getMaxTokens,
  getProviderProfile,
  knownProviderNames,
  listProviders,
  registerProvider,
  resolveProviderName,
} from "../src/providers/index.js";
import { buildClient } from "../src/transports/index.js";

describe("T10 provider registry", () => {
  it("keeps Codex special and preserves Python verbatim registration", () => {
    expect(listProviders()).toHaveLength(11);
    expect(getProviderProfile("openai-codex")).toBeNull();
    expect(CODEX_PROVIDER).toMatchObject({
      name: "openai-codex",
      apiMode: "responses",
      requiresApiKey: false,
      authType: "oauth_external",
      fallbackModels: ["gpt-5.5"],
      defaultAuxModel: "",
    });
    expect(() => buildClient(CODEX_PROVIDER, "x")).toThrow(
      "ValueError: no client wired for api_mode 'responses'",
    );

    registerProvider({
      ...CODEX_PROVIDER,
      name: "ZZTest",
      aliases: ["UPPER"],
      apiMode: "chat_completions",
    });
    for (const name of ["ZZTest", "zztest", "UPPER", "upper"])
      expect(getProviderProfile(name)).toBeNull();
  });

  it("registerProvider is visible to listProviders/knownProviderNames and env-var auto-detect (contract T11 — matches Python's unified _REGISTRY, unlike a builtins-only list)", () => {
    const before = listProviders().length;
    registerProvider({
      ...CODEX_PROVIDER,
      name: "fakeprov-t11",
      aliases: [],
      apiMode: "chat_completions",
      envVars: ["FAKE_T11_KEY"],
    });
    expect(listProviders().length).toBe(before + 1);
    expect(listProviders().map((p) => p.name)).toContain("fakeprov-t11");
    expect(knownProviderNames()).toContain("fakeprov-t11");
    expect(resolveProviderName(undefined, undefined, { FAKE_T11_KEY: "x" })).toBe("fakeprov-t11");
  });

  it("does not trim module lookup and uses only profile defaults for max tokens", () => {
    expect(getProviderProfile(" claude")).toBeNull();
    expect(getProviderProfile("ClAuDe")?.name).toBe("anthropic");
    expect(getMaxTokens("anthropic", "anything")).toBe(16000);
    expect(getMaxTokens("openrouter", "anything")).toBe(8192);
  });
});
