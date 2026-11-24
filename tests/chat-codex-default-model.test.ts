// Issue #998: `lohra chat`, `lohra dashboard` e `lohra models` na rota Codex
// usam o modelo padrão do próprio Codex; sem nenhum resolvível, recusam
// antes da rede em vez de mandar "gpt-5.5" fixo ao backend.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { enable, writeTokens } from "../src/auth/index.js";
import { buildCatalog } from "../src/catalog/catalog.js";
import { parseCommand } from "../src/cli/arg-validation.js";
import { DASHBOARD_SPEC } from "../src/cli/arg-spec.js";
import { runChat } from "../src/commands/chat.js";
import { runDashboard } from "../src/commands/dashboard.js";
import { NativeChatHttpPort } from "../src/transports/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Fixture {
  readonly base: string;
  readonly home: string;
  readonly codexHome: string;
}

function fixture(cacheSlug?: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), "lohra-998-chat-"));
  roots.push(base);
  const home = join(base, ".lohra");
  const codexHome = join(base, ".codex");
  mkdirSync(codexHome, { recursive: true });
  enable(home);
  writeTokens(home, {
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
    accountId: "acct-998",
    expiresAt: Date.now() / 1000 + 999_999,
  });
  if (cacheSlug !== undefined)
    writeFileSync(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "codex-auto-review", priority: 0, visibility: "hide" },
          { slug: cacheSlug, priority: 1, visibility: "list" },
        ],
      }),
    );
  return { base, home, codexHome };
}

async function chat(fx: Fixture, extra: [string, string][] = []) {
  const result = await runChat({
    input: "oi",
    flags: new Map<string, string | true>([...extra, ["--json", true], ["--no-tools", true]]),
    environment: { HOME: fx.base },
    home: fx.home,
    codexHome: fx.codexHome,
    cwd: fx.base,
  });
  return {
    ...result,
    envelope: JSON.parse(result.stdout) as {
      model: string | null;
      error: string | null;
      api_calls: number;
    },
  };
}

function bodyModel(spy: { mock: { calls: unknown[][] } }): string | undefined {
  const call = spy.mock.calls[0]?.[0] as { readonly body: string } | undefined;
  return (JSON.parse(call?.body ?? "{}") as { readonly model?: string }).model;
}

describe("runChat na rota Codex (issue #998)", () => {
  it("sem `model =` no config, manda ao transporte o padrão do catálogo do Codex", async () => {
    const fx = fixture("gpt-codex-catalog-default");
    const postSpy = vi
      .spyOn(NativeChatHttpPort.prototype, "post")
      .mockRejectedValue(new Error("998: sem rede em teste"));
    const result = await chat(fx);
    expect(postSpy).toHaveBeenCalled();
    expect(bodyModel(postSpy)).toBe("gpt-codex-catalog-default");
    expect(result.envelope.model).toBe("gpt-codex-catalog-default");
  });

  it("o `model =` do usuário vence o catálogo", async () => {
    const fx = fixture("gpt-codex-catalog-default");
    writeFileSync(join(fx.codexHome, "config.toml"), 'model = "gpt-user-choice"\n');
    const postSpy = vi
      .spyOn(NativeChatHttpPort.prototype, "post")
      .mockRejectedValue(new Error("998: sem rede em teste"));
    await chat(fx);
    expect(bodyModel(postSpy)).toBe("gpt-user-choice");
  });

  it("--model continua vencendo", async () => {
    const fx = fixture("gpt-codex-catalog-default");
    const postSpy = vi
      .spyOn(NativeChatHttpPort.prototype, "post")
      .mockRejectedValue(new Error("998: sem rede em teste"));
    await chat(fx, [["--model", "gpt-explicit-flag"]]);
    expect(bodyModel(postSpy)).toBe("gpt-explicit-flag");
  });

  it("sem config nem catálogo, recusa antes da rede com mensagem acionável", async () => {
    const fx = fixture();
    const postSpy = vi
      .spyOn(NativeChatHttpPort.prototype, "post")
      .mockRejectedValue(new Error("998: sem rede em teste"));
    const result = await chat(fx);
    expect(postSpy).not.toHaveBeenCalled();
    expect(result.code).toBe(2);
    expect(result.envelope.model).toBeNull();
    expect(result.envelope.api_calls).toBe(0);
    expect(result.envelope.error).toContain(join(fx.codexHome, "config.toml"));
    expect(result.envelope.error).toContain("--model");
  });
});

describe("runDashboard na rota Codex (issue #998)", () => {
  it("sem modelo resolvível, sai 2 antes de subir o gateway", async () => {
    const fx = fixture();
    const stderrLines: string[] = [];
    const code = await runDashboard({
      flags: parseCommand(DASHBOARD_SPEC, []).options,
      environment: { HOME: fx.base },
      home: fx.home,
      codexHome: fx.codexHome,
      cwd: fx.base,
      stderr: (text: string) => stderrLines.push(text),
      port: 0,
    });
    expect(code).toBe(2);
    const stderr = stderrLines.join("");
    expect(stderr).toContain(join(fx.codexHome, "config.toml"));
    expect(stderrLines.some((line) => line.startsWith("Lohra dashboard:"))).toBe(false);
  });
});

describe("buildCatalog da assinatura (issue #998)", () => {
  it("sem modelo resolvido, não inventa um nome", async () => {
    const catalog = await buildCatalog({ providers: ["openai-codex"], subscriptionActive: true });
    const entry = catalog.entries[0];
    expect(entry?.models).toEqual([]);
    expect(entry?.models).not.toContain("gpt-5.5");
  });

  it("com modelo resolvido, lista exatamente ele", async () => {
    const catalog = await buildCatalog({
      providers: ["openai-codex"],
      subscriptionActive: true,
      subscriptionModel: "gpt-codex-catalog-default",
    });
    expect(catalog.entries[0]?.models).toEqual(["gpt-codex-catalog-default"]);
  });
});
