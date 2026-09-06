import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
    expect(tool.handle({})).toBe('{"error": "unknown action undefined (use add/replace/remove)"}');
    expect(tool.handle({ action: "add", target: "nope", text: "fact" })).toBe(
      '{"ok": true, "target": "nope", "entry_count": 1}',
    );
    expect(tool.handle({ action: "replace", old_text: "fact", new_text: "changed" })).toBe(
      '{"ok": true, "target": "memory", "entry_count": 1}',
    );
    expect(tool.handle({ action: "remove", old_text: "changed" })).toBe(
      '{"ok": true, "target": "memory", "entry_count": 0}',
    );
  });

  it("creates, views, updates and deletes skills", () => {
    const tool = new SkillTool(new SkillStore(root()));
    expect(tool.manage({ action: "create", name: "one", body: "body" })).toBe(
      '{"ok": true, "action": "create", "name": "one", "scope": "home"}',
    );
    expect(tool.view({ name: "one" })).toBe(
      '{"ok": true, "name": "one", "version": "1.0.0", "body": "body"}',
    );
    expect(tool.manage({ action: "update", name: "one", description: "new" })).toBe(
      '{"ok": true, "action": "update", "name": "one"}',
    );
    expect(tool.manage({ action: "delete", name: "one" })).toBe(
      '{"ok": true, "action": "delete", "name": "one"}',
    );
    expect(tool.manage({ name: "one" })).toBe(
      '{"error": "unknown action undefined (use create/update/delete)"}',
    );
  });

  it("implements discovery, browse and read boundaries", () => {
    const db = {
      searchMessages: (query: string, limit: number) => [{ query, limit }],
      listSessions: () => [],
      loadMessages: (id: string) => [{ id }],
    };
    const tool = new SessionSearchTool(db);
    expect(tool.handle({ mode: "browse" })).toBe('{"ok": true, "sessions": []}');
    expect(tool.handle({ mode: "read" })).toBe("{\"error\": \"'read' requires 'session_id'\"}");
    expect(tool.handle({ mode: "discovery" })).toBe(
      "{\"error\": \"'discovery' requires 'query'\"}",
    );
    expect(tool.handle({})).toBe('{"error": "unknown mode undefined (use discovery/browse/read)"}');
    expect(tool.handle({ mode: "frobnicate" })).toBe(
      '{"error": "unknown mode \\"frobnicate\\" (use discovery/browse/read)"}',
    );
  });

  it("lists one explicit no-key provider with zero ambient credentials", async () => {
    const tool = new ListModelsTool(root(), {});
    expect(await tool.handle({ provider: "anthropic" })).toBe(
      '{"ok": true, "providers": [{"provider": "anthropic", "source": "skipped", "total": 0, "models": [], "detail": "no API key \\u2014 set ANTHROPIC_API_KEY"}], "tiers": {"small": null, "medium": null, "big": null}}',
    );
    expect(await tool.handle({ provider: "no_such_provider" })).toBe(
      '{"error": "unknown provider \\"no_such_provider\\" \\u2014 call list_models with no \'provider\' to see the ones this install knows about"}',
    );
  });
});

describe("builtin registry", () => {
  it("registers the 24 Python schemas in exact order", () => {
    const registry = createBuiltinRegistry();
    expect(registry.generation).toBe(24);
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
      "list_models",
    ]);
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
