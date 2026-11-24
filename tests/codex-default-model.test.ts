// Issue #998 (dogfood A3 da 0.1.1): sem `model =` no `config.toml`, a rota
// Codex caía em "gpt-5.5" fixo, que o backend recusa para conta ChatGPT
// (`model_not_found`). O padrão agora é o do próprio Codex CLI
// (`codex-rs/models-manager`): `model` do profile ativo, `model` de topo do
// `config.toml`, e só então o catálogo `models_cache.json` por `priority`,
// primeiro com `visibility: "list"`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  noCodexModelMessage,
  readCodexModel,
  resolveCodexDefaultModel,
} from "../src/auth/codex.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function codexHome(files: { readonly config?: string; readonly cache?: unknown }): string {
  const home = mkdtempSync(join(tmpdir(), "lohra-998-codex-"));
  roots.push(home);
  mkdirSync(home, { recursive: true });
  if (files.config !== undefined) writeFileSync(join(home, "config.toml"), files.config);
  if (files.cache !== undefined)
    writeFileSync(
      join(home, "models_cache.json"),
      typeof files.cache === "string" ? files.cache : JSON.stringify(files.cache),
    );
  return home;
}

const cache = (
  ...models: { slug: string; priority?: number; visibility?: string }[]
): { models: typeof models } => ({ models });

describe("resolveCodexDefaultModel (issue #998)", () => {
  it("usa o `model` de topo do config.toml antes do catálogo", () => {
    const home = codexHome({
      config: 'model = "gpt-user-set"\n',
      cache: cache({ slug: "gpt-cache-first", priority: 1, visibility: "list" }),
    });
    expect(resolveCodexDefaultModel(home)).toBe("gpt-user-set");
  });

  it("o `model` do profile ativo vence o de topo", () => {
    const home = codexHome({
      config: [
        'model = "gpt-top"',
        'profile = "work"',
        "",
        "[profiles.work]",
        'model = "gpt-work"',
        "",
        "[profiles.other]",
        'model = "gpt-other"',
        "",
      ].join("\n"),
    });
    expect(resolveCodexDefaultModel(home)).toBe("gpt-work");
  });

  it("ignora `model` dentro de uma tabela que não é o profile ativo", () => {
    const home = codexHome({
      config: [
        '[projects."/workspace/x"]',
        'trust_level = "trusted"',
        "[profiles.other]",
        'model = "gpt-other"',
        "",
      ].join("\n"),
      cache: cache({ slug: "gpt-cache-first", priority: 1, visibility: "list" }),
    });
    expect(readCodexModel(home)).toBeNull();
    expect(resolveCodexDefaultModel(home)).toBe("gpt-cache-first");
  });

  it("aceita comentário no fim da linha e aspas simples", () => {
    expect(resolveCodexDefaultModel(codexHome({ config: "model = 'gpt-q' # meu\n" }))).toBe(
      "gpt-q",
    );
  });

  it("sem config, escolhe o primeiro visível por priority no models_cache.json", () => {
    const home = codexHome({
      cache: cache(
        { slug: "gpt-low", priority: 9, visibility: "list" },
        { slug: "gpt-hidden", priority: 1, visibility: "hide" },
        { slug: "gpt-picker-default", priority: 2, visibility: "list" },
      ),
    });
    expect(resolveCodexDefaultModel(home)).toBe("gpt-picker-default");
  });

  it("sem nenhum visível, cai no primeiro por priority", () => {
    const home = codexHome({
      cache: cache(
        { slug: "gpt-b", priority: 5, visibility: "hide" },
        { slug: "gpt-a", priority: 3, visibility: "hide" },
      ),
    });
    expect(resolveCodexDefaultModel(home)).toBe("gpt-a");
  });

  it("priority ausente vai para o fim", () => {
    const home = codexHome({
      cache: cache(
        { slug: "gpt-sem-prioridade", visibility: "list" },
        { slug: "gpt-com", priority: 7, visibility: "list" },
      ),
    });
    expect(resolveCodexDefaultModel(home)).toBe("gpt-com");
  });

  it("sem config e sem catálogo (ou catálogo inválido), devolve null — nunca um nome fixo", () => {
    expect(resolveCodexDefaultModel(codexHome({}))).toBeNull();
    expect(resolveCodexDefaultModel(codexHome({ cache: "{not json" }))).toBeNull();
    expect(resolveCodexDefaultModel(codexHome({ cache: { models: [] } }))).toBeNull();
    expect(
      resolveCodexDefaultModel(codexHome({ cache: { models: [{ priority: 1 }] } })),
    ).toBeNull();
  });

  it("a mensagem sem modelo cita o config.toml do CODEX_HOME e as saídas", () => {
    const home = codexHome({});
    const message = noCodexModelMessage(home);
    expect(message).toContain(join(home, "config.toml"));
    expect(message).toContain("--model");
    expect(message).toContain("models_cache.json");
    expect(message).not.toContain("gpt-5.5");
  });
});
