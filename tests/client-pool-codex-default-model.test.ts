// Issue #998, observação do review no #1003: uma delegação com
// `provider: "openai-codex"` e sem `model` caía em
// `pair[0].fallbackModels[0]` (`configureFor`, src/agent/client-pool.ts).
// Com a lista vazia isso falha; o caminho certo é a mesma resolução do
// chat (`--model` explícito, senão o padrão do Codex).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClientPool, configureFor, ProviderError } from "../src/agent/client-pool.js";
import { enable, setPreference } from "../src/auth/manage.js";
import { getProviderProfile } from "../src/providers/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout(files: { readonly config?: string; readonly cache?: unknown } = {}): {
  readonly home: string;
  readonly codexHome: string;
} {
  const root = mkdtempSync(join(tmpdir(), "lohra-998-pool-"));
  roots.push(root);
  const home = join(root, "lohra");
  const codexHome = join(root, "codex");
  mkdirSync(home, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  enable(home);
  setPreference(home, "subscription");
  if (files.config !== undefined) writeFileSync(join(codexHome, "config.toml"), files.config);
  if (files.cache !== undefined)
    writeFileSync(
      join(codexHome, "models_cache.json"),
      typeof files.cache === "string" ? files.cache : JSON.stringify(files.cache),
    );
  return { home, codexHome };
}

function poolOf(paths: { readonly home: string; readonly codexHome: string }): ClientPool {
  const parent = getProviderProfile("anthropic");
  if (parent === null) throw new Error("missing anthropic profile");
  return new ClientPool(
    parent,
    {},
    {
      home: paths.home,
      codexHome: paths.codexHome,
      environment: {},
      buildSubscription: () => ({}),
    },
  );
}

describe("configureFor com provider openai-codex e sem model (issue #998)", () => {
  it("usa o model do config.toml, não falha por fallbackModels vazio", async () => {
    const paths = layout({
      config: 'model = "gpt-from-config"\n',
      cache: { models: [{ slug: "gpt-from-cache", priority: 1, visibility: "list" }] },
    });
    const configured = await configureFor(poolOf(paths), { provider: "openai-codex" });
    expect(configured).toEqual(
      expect.objectContaining({
        model: "gpt-from-config",
      }),
    );
  });

  it("sem config.toml, usa o padrão do models_cache.json", async () => {
    const paths = layout({
      cache: { models: [{ slug: "gpt-from-cache", priority: 1, visibility: "list" }] },
    });
    const configured = await configureFor(poolOf(paths), { provider: "openai-codex" });
    expect(configured).toEqual(expect.objectContaining({ model: "gpt-from-cache" }));
  });

  it("um --model explícito vence o padrão do Codex", async () => {
    const paths = layout({ config: 'model = "gpt-from-config"\n' });
    const configured = await configureFor(poolOf(paths), {
      provider: "openai-codex",
      model: "gpt-explicit",
    });
    expect(configured).toEqual(expect.objectContaining({ model: "gpt-explicit" }));
  });

  it("sem modelo no Codex, recusa com a mensagem acionável — nunca gpt-5.5", async () => {
    const paths = layout();
    const failure = await configureFor(poolOf(paths), { provider: "openai-codex" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProviderError);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain(join(paths.codexHome, "config.toml"));
    expect(message).toContain("models_cache.json");
    expect(message).toContain("--model");
    expect(message).not.toContain("gpt-5.5");
    expect(message).not.toContain("has no default model");
  });

  it("provedor que não é Codex continua no fallbackModels[0]", async () => {
    const anthropic = getProviderProfile("anthropic");
    if (anthropic === null) throw new Error("missing anthropic profile");
    const paths = layout({ config: 'model = "gpt-from-config"\n' });
    const pool = new ClientPool(
      anthropic,
      {},
      {
        home: paths.home,
        codexHome: paths.codexHome,
        environment: {},
      },
    );
    const configured = await configureFor(pool, { provider: "anthropic" });
    expect(configured).toEqual(expect.objectContaining({ model: anthropic.fallbackModels[0] }));
  });
});
