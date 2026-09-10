import { describe, expect, it } from "vitest";

import { resolveContextWindow } from "../src/providers/context-window.js";
import { CODEX_PROVIDER, getProviderProfile } from "../src/providers/registry.js";
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

  it("nível 3: prefixo exige separador depois — 'gpt-4' não casa com 'gpt-45'", () => {
    const profile = fakeProfile({
      modelWindows: { "gpt-4": 8_000 },
      defaultContextWindow: 64_000,
    });
    expect(resolveContextWindow({ provider: "fake", model: "gpt-45-turbo", profile })).toEqual({
      tokens: 64_000,
      source: "provider",
    });
    expect(resolveContextWindow({ provider: "fake", model: "gpt-4.turbo", profile })).toEqual({
      tokens: 8_000,
      source: "table",
    });
    expect(resolveContextWindow({ provider: "fake", model: "gpt-4", profile })).toEqual({
      tokens: 8_000,
      source: "table",
    });
  });

  it("nível 3: uma entrada da tabela com valor inválido é ignorada, não escolhida", () => {
    const profile = fakeProfile({
      modelWindows: { "gpt-4": 0, "gpt-4-legacy": -5 },
      defaultContextWindow: 64_000,
    });
    expect(resolveContextWindow({ provider: "fake", model: "gpt-4-legacy-2020", profile })).toEqual(
      { tokens: 64_000, source: "provider" },
    );
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

describe("resolveContextWindow — perfis reais do registry (issue #250)", () => {
  it("openai: um id datado de gpt-4o-mini casa com a entrada mais específica da tabela", () => {
    // gpt-4o e gpt-4o-mini têm de fato a mesma janela real (128k) — este
    // teste não distingue qual prefixo venceu por valor; quem prova que o
    // prefixo mais longo (não o mais curto) é escolhido é o teste sintético
    // de nível 3 acima, com 8_000 vs 128_000.
    const profile = getProviderProfile("openai");
    if (profile === null) throw new Error("expected openai profile");
    expect(
      resolveContextWindow({
        provider: "openai",
        model: "gpt-4o-mini-2024-07-18",
        profile,
      }),
    ).toEqual({ tokens: 128_000, source: "table" });
  });

  it("anthropic: um modelo fora da tabela cai no piso do provedor, não no default global", () => {
    const profile = getProviderProfile("anthropic");
    if (profile === null) throw new Error("expected anthropic profile");
    expect(
      resolveContextWindow({
        provider: "anthropic",
        model: "claude-opus-4-8",
        profile,
      }),
    ).toEqual({ tokens: 200_000, source: "provider" });
  });

  it("ollama: sem tabela nem piso, cai no default global de 200000", () => {
    const profile = getProviderProfile("ollama");
    if (profile === null) throw new Error("expected ollama profile");
    expect(
      resolveContextWindow({
        provider: "ollama",
        model: "qualquer-modelo-local",
        profile,
      }),
    ).toEqual({ tokens: 200_000, source: "default" });
  });

  it("codex: gpt-5.5 via subscription resolve pela tabela do próprio CODEX_PROVIDER", () => {
    expect(
      resolveContextWindow({
        provider: "openai-codex",
        model: "gpt-5.5",
        profile: CODEX_PROVIDER,
      }),
    ).toEqual({ tokens: 1_050_000, source: "table" });
  });

  it("codex: um modelo de subscription futuro sem entrada na tabela cai no piso da família GPT-5.x, não no default global", () => {
    expect(
      resolveContextWindow({
        provider: "openai-codex",
        model: "gpt-6-not-yet-listed",
        profile: CODEX_PROVIDER,
      }),
    ).toEqual({ tokens: 1_050_000, source: "provider" });
  });

  it("modelWindows dos perfis do registry é congelado — não é o único container aninhado que escapa do deep-freeze", () => {
    const openai = getProviderProfile("openai");
    if (openai === null) throw new Error("expected openai profile");
    if (openai.modelWindows === undefined) throw new Error("expected openai.modelWindows");
    expect(Object.isFrozen(openai.modelWindows)).toBe(true);
    expect(() => {
      // @ts-expect-error — mutação deliberada para provar o freeze em runtime
      openai.modelWindows["gpt-4o"] = 1;
    }).toThrow(TypeError);

    if (CODEX_PROVIDER.modelWindows === undefined) {
      throw new Error("expected CODEX_PROVIDER.modelWindows");
    }
    expect(Object.isFrozen(CODEX_PROVIDER.modelWindows)).toBe(true);
    expect(() => {
      // @ts-expect-error — mutação deliberada para provar o freeze em runtime
      CODEX_PROVIDER.modelWindows["gpt-5.5"] = 1;
    }).toThrow(TypeError);
  });
});
