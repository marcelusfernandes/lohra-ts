import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Catalog, ProviderModels } from "../src/catalog/types.js";
import { CONTEXT_WINDOWS_FILENAME } from "../src/catalog/windows-cache.js";
import { MemoryStore } from "../src/memory/index.js";
import { SkillStore } from "../src/skills/index.js";
import {
  ListModelsTool,
  MemoryTool,
  SessionSearchTool,
  SkillTool,
  createBuiltinRegistry,
  toolError,
} from "../src/tools/index.js";

const roots: string[] = [];
const root = (): string => {
  const path = mkdtempSync(join(tmpdir(), "lohra-stateful-tools-"));
  roots.push(path);
  return path;
};

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("stateful tool handlers", () => {
  it("mutates memory and preserves the default-target quirk", () => {
    const tool = new MemoryTool(new MemoryStore(root()));
    expect(tool.handle({})).toBe('{"error":"unknown action undefined (use add/replace/remove)"}');
    expect(tool.handle({ action: "add", target: "nope", text: "fact" })).toBe(
      '{"ok":true,"target":"nope","entry_count":1}',
    );
    expect(tool.handle({ action: "replace", old_text: "fact", new_text: "changed" })).toBe(
      '{"ok":true,"target":"memory","entry_count":1}',
    );
    expect(tool.handle({ action: "remove", old_text: "changed" })).toBe(
      '{"ok":true,"target":"memory","entry_count":0}',
    );
  });

  it("creates, views, updates and deletes skills", () => {
    const tool = new SkillTool(new SkillStore(root()));
    expect(tool.manage({ action: "create", name: "one", body: "body" })).toBe(
      '{"ok":true,"action":"create","name":"one","scope":"home"}',
    );
    expect(tool.view({ name: "one" })).toBe(
      '{"ok":true,"name":"one","version":"1.0.0","body":"body"}',
    );
    expect(tool.manage({ action: "update", name: "one", description: "new" })).toBe(
      '{"ok":true,"action":"update","name":"one"}',
    );
    expect(tool.manage({ action: "delete", name: "one" })).toBe(
      '{"ok":true,"action":"delete","name":"one"}',
    );
    expect(tool.manage({ name: "one" })).toBe(
      '{"error":"unknown action undefined (use create/update/delete)"}',
    );
  });

  it("implements discovery, browse and read boundaries", () => {
    const db = {
      searchMessages: (query: string, limit: number) => [{ query, limit }],
      listSessions: () => [],
      loadMessages: (id: string) => [{ id }],
    };
    const tool = new SessionSearchTool(db);
    expect(tool.handle({ mode: "browse" })).toBe('{"ok":true,"sessions":[]}');
    expect(tool.handle({ mode: "read" })).toBe("{\"error\":\"'read' requires 'session_id'\"}");
    expect(tool.handle({ mode: "discovery" })).toBe("{\"error\":\"'discovery' requires 'query'\"}");
    expect(tool.handle({})).toBe('{"error":"unknown mode undefined (use discovery/browse/read)"}');
    expect(tool.handle({ mode: "frobnicate" })).toBe(
      '{"error":"unknown mode \\"frobnicate\\" (use discovery/browse/read)"}',
    );
  });

  it("lists one explicit no-key provider with zero ambient credentials", async () => {
    const tool = new ListModelsTool(root(), {});
    expect(await tool.handle({ provider: "anthropic" })).toBe(
      '{"ok":true,"providers":[{"provider":"anthropic","source":"skipped","total":0,"models":[],"detail":"no API key — set ANTHROPIC_API_KEY"}],"tiers":{"small":null,"medium":null,"big":null}}',
    );
    expect(await tool.handle({ provider: "no_such_provider" })).toBe(
      '{"error":"unknown provider \\"no_such_provider\\" — call list_models with no \'provider\' to see the ones this install knows about"}',
    );
  });

  it("shows context_window per model from a live catalog fetch (issue #249)", async () => {
    const builder = () =>
      Promise.resolve(
        new Catalog([
          new ProviderModels("openrouter", "live", ["a/b", "c/d"], 2, "", {
            "a/b": 200000,
            "c/d": null,
          }),
        ]),
      );
    const tool = new ListModelsTool(root(), {}, builder);
    const result = JSON.parse(await tool.handle({})) as {
      readonly providers: readonly { readonly context_window?: Record<string, number | null> }[];
    };
    expect(result.providers[0]?.context_window).toEqual({ "a/b": 200000, "c/d": null });
  });

  it("persists windows to ~/.lohra/context-windows.json and falls back to them across a restart", async () => {
    const home = root();
    const liveBuilder = () =>
      Promise.resolve(
        new Catalog([new ProviderModels("openrouter", "live", ["a/b"], 1, "", { "a/b": 200000 })]),
      );
    const first = new ListModelsTool(home, {}, liveBuilder);
    await first.handle({});
    const onDisk = JSON.parse(readFileSync(join(home, CONTEXT_WINDOWS_FILENAME), "utf8")) as {
      readonly schema_version: number;
      readonly providers: Record<string, Record<string, number | null>>;
    };
    expect(onDisk.schema_version).toBe(1);
    expect(onDisk.providers.openrouter).toEqual({ "a/b": 200000 });

    // A "reinício": um builder que não trouxe nada ao vivo desta vez (erro),
    // mas o modelo já é conhecido pela última busca — a segunda instância
    // simula um processo novo lendo o mesmo home.
    const errorBuilder = () =>
      Promise.resolve(
        new Catalog([new ProviderModels("openrouter", "error", ["a/b"], 1, "timeout")]),
      );
    const second = new ListModelsTool(home, {}, errorBuilder);
    const result = JSON.parse(await second.handle({})) as {
      readonly providers: readonly { readonly context_window?: Record<string, number | null> }[];
    };
    expect(result.providers[0]?.context_window).toEqual({ "a/b": 200000 });
  });

  it("keeps a known window when a live refetch reports null for the same model, both in the response and on disk (issue #264)", async () => {
    const home = root();
    const firstBuilder = () =>
      Promise.resolve(
        new Catalog([new ProviderModels("openrouter", "live", ["a/b"], 1, "", { "a/b": 200000 })]),
      );
    const first = new ListModelsTool(home, {}, firstBuilder);
    await first.handle({});

    const nullBuilder = () =>
      Promise.resolve(
        new Catalog([new ProviderModels("openrouter", "live", ["a/b"], 1, "", { "a/b": null })]),
      );
    const second = new ListModelsTool(home, {}, nullBuilder);
    const result = JSON.parse(await second.handle({})) as {
      readonly providers: readonly { readonly context_window?: Record<string, number | null> }[];
    };
    expect(result.providers[0]?.context_window).toEqual({ "a/b": 200000 });

    const onDisk = JSON.parse(readFileSync(join(home, CONTEXT_WINDOWS_FILENAME), "utf8")) as {
      readonly providers: Record<string, Record<string, number | null>>;
    };
    expect(onDisk.providers.openrouter).toEqual({ "a/b": 200000 });
  });

  it("surfaces a cache corruption warning instead of crashing (issue #249)", async () => {
    const home = root();
    writeFileSync(join(home, CONTEXT_WINDOWS_FILENAME), "{not json");
    const tool = new ListModelsTool(home, {}, () =>
      Promise.resolve(new Catalog([new ProviderModels("anthropic", "skipped", [], 0, "no key")])),
    );
    const result = JSON.parse(await tool.handle({})) as { readonly note?: string };
    expect(result.note).toMatch(/refetch/iu);
  });

  it("returns a named tool_error, not an empty tier map, for a broken workflow_tiers.json, and never reaches the catalog builder (error-before-network, #276)", async () => {
    const home = root();
    writeFileSync(join(home, "workflow_tiers.json"), "[");
    const neverBuilder = () =>
      Promise.reject(new Error("catalog builder must not be reached when tiers are invalid"));
    const tool = new ListModelsTool(home, {}, neverBuilder);
    const result = JSON.parse(await tool.handle({})) as { readonly error?: string };
    expect(result.error).toContain(join(home, "workflow_tiers.json"));
  });
});

describe("builtin registry", () => {
  it("registers the 24 Python schemas plus the 2 native ones (workflow_notices/_ack, #402) in exact order", () => {
    const registry = createBuiltinRegistry();
    expect(registry.generation).toBe(26);
    expect(registry.getDefinitions().map((definition) => definition.function.name)).toEqual([
      "read_file",
      "write_file",
      "terminal",
      "web_fetch",
      "web_search",
      "memory",
      "skill_view",
      "skill_manage",
      "session_search",
      "delegate_task",
      "cronjob",
      "vision_analyze",
      "image_gen",
      "spawn_session",
      "steer_session",
      "collect_session",
      "run_workflow",
      "workflow_status",
      "workflow_list",
      "workflow_pause",
      "workflow_cancel",
      "workflow_templates",
      "workflow_audit",
      "workflow_notices",
      "workflow_notices_ack",
      "list_models",
    ]);
  });

  it("documents that list_models writes context-windows.json, not read-only (issue #264)", () => {
    const registry = createBuiltinRegistry();
    const definition = registry
      .getDefinitions()
      .find((candidate) => candidate.function.name === "list_models");
    expect(definition?.function.description).toContain("context-windows.json");
    expect(definition?.function.description).not.toMatch(/read-only/iu);
  });

  it("keeps distinct fail-safe literals for every intercepted family", async () => {
    const registry = createBuiltinRegistry();
    expect(await registry.dispatch("memory", {})).toBe(
      toolError("the memory tool must be intercepted with a session MemoryStore"),
    );
    expect(await registry.dispatch("workflow_audit", {})).toBe(
      toolError("workflow_audit must be intercepted with a SessionDB"),
    );
    expect(await registry.dispatch("delegate_task", {})).toBe(
      toolError("the delegate_task tool must be intercepted with a session orchestration core"),
    );
  });
});
