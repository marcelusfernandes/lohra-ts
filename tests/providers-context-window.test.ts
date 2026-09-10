import { describe, expect, it } from "vitest";

import { resolveContextWindow } from "../src/providers/context-window.js";
import type { ProviderProfile } from "../src/providers/types.js";

function fakeProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    name: "fake",
    apiMode: "chat_completions",
    aliases: [],
    displayName: "Fake",
    description: "",
    signupUrl: "",
    envVars: [],
    baseUrl: "",
    modelsUrl: "",
    requiresApiKey: false,
    supportsVision: false,
    fallbackModels: [],
    defaultMaxTokens: 8192,
    defaultAuxModel: "",
    ...overrides,
  };
}

describe("resolveContextWindow — cinco níveis pinados (issue #250)", () => {
  it("nível 1: override vence mesmo com catalog, table e floor presentes", () => {
    const profile = fakeProfile({
      defaultContextWindow: 50_000,
      modelWindows: { "gpt-4": 10_000 },
    });
    const result = resolveContextWindow({
      provider: "fake",
      model: "gpt-4",
      override: 999_999,
      catalog: { fake: { "gpt-4": 1_000 } },
      profile,
    });
    expect(result).toEqual({ tokens: 999_999, source: "override" });
  });

  it("nível 2: catalog vence sobre table e floor quando não há override", () => {
    const profile = fakeProfile({
      defaultContextWindow: 50_000,
      modelWindows: { "gpt-4": 10_000 },
    });
    const result = resolveContextWindow({
      provider: "fake",
      model: "gpt-4",
      catalog: { fake: { "gpt-4": 77_000 } },
      profile,
    });
    expect(result).toEqual({ tokens: 77_000, source: "catalog" });
  });

  it("catalog com o modelo ausente ou null cai para o próximo nível", () => {
    const profile = fakeProfile({
      defaultContextWindow: 50_000,
      modelWindows: { "gpt-4": 10_000 },
    });
    expect(
      resolveContextWindow({
        provider: "fake",
        model: "gpt-4",
        catalog: { fake: { "gpt-4": null } },
        profile,
      }),
    ).toEqual({ tokens: 10_000, source: "table" });
    expect(
      resolveContextWindow({
        provider: "fake",
        model: "gpt-4",
        catalog: { other: { "gpt-4": 5 } },
        profile,
      }),
    ).toEqual({ tokens: 10_000, source: "table" });
  });

  it("nível 3: table por prefixo mais longo — o id datado casa com a entrada mais específica", () => {
    const profile = fakeProfile({
      modelWindows: { "gpt-4": 8_000, "gpt-4o-mini": 128_000 },
    });
    expect(
      resolveContextWindow({
        provider: "fake",
        model: "gpt-4o-mini-2024-07-18",
        profile,
      }),
    ).toEqual({ tokens: 128_000, source: "table" });
    expect(
      resolveContextWindow({
        provider: "fake",
        model: "gpt-4-turbo",
        profile,
      }),
    ).toEqual({ tokens: 8_000, source: "table" });
  });

  it("nível 4: piso do provedor quando não há entrada na tabela", () => {
    const profile = fakeProfile({ defaultContextWindow: 64_000 });
    expect(
      resolveContextWindow({
        provider: "fake",
        model: "unknown-model",
        profile,
      }),
    ).toEqual({ tokens: 64_000, source: "provider" });
  });

  it("nível 5: 200000 quando nada mais resolve", () => {
    const profile = fakeProfile();
    expect(
      resolveContextWindow({
        provider: "fake",
        model: "unknown-model",
        profile,
      }),
    ).toEqual({ tokens: 200_000, source: "default" });
  });

  it("override inválido lança erro nomeado em vez de cair silenciosamente para outro nível", () => {
    const profile = fakeProfile({ defaultContextWindow: 64_000 });
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        resolveContextWindow({ provider: "fake", model: "m", override: bad, profile }),
      ).toThrow(/CONTEXT_WINDOW_INVALID_OVERRIDE/);
    }
  });

  it("override null ou undefined não conta como override — segue a cadeia normalmente", () => {
    const profile = fakeProfile({ defaultContextWindow: 64_000 });
    expect(resolveContextWindow({ provider: "fake", model: "m", override: null, profile })).toEqual(
      { tokens: 64_000, source: "provider" },
    );
    expect(
      resolveContextWindow({ provider: "fake", model: "m", override: undefined, profile }),
    ).toEqual({ tokens: 64_000, source: "provider" });
  });
});
