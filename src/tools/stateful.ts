import { join } from "node:path";

import { buildCatalog } from "../catalog/catalog.js";
import type { Catalog, ProviderModels } from "../catalog/types.js";
import { MemoryStore } from "../memory/store.js";
import { SkillStore } from "../skills/store.js";
import { loadTiers, MODEL_TIERS, type TierMap } from "../workflow/tiers.js";
import { toolError, toolResult } from "./envelope.js";
import type { ToolArguments } from "./types.js";

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export class MemoryTool {
  constructor(private readonly store: MemoryStore) {}

  handle(args: ToolArguments): string {
    const action = args.action;
    const target = text(args.target) ?? "memory";
    const file = this.store.fileFor(target);
    try {
      if (action === "add") {
        const value = text(args.text);
        if (!value) return toolError("'add' requires 'text'");
        file.add(value);
      } else if (action === "replace") {
        const oldText = text(args.old_text);
        const newText = text(args.new_text);
        if (!oldText || newText === null) {
          return toolError("'replace' requires 'old_text' and 'new_text'");
        }
        file.replace(oldText, newText);
      } else if (action === "remove") {
        const oldText = text(args.old_text);
        if (!oldText) return toolError("'remove' requires 'old_text'");
        file.remove(oldText);
      } else {
        const cited = action === undefined ? "undefined" : JSON.stringify(action);
        return toolError(`unknown action ${cited} (use add/replace/remove)`);
      }
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
    return toolResult(undefined, { target, entry_count: file.entries().length });
  }
}

export class SkillTool {
  constructor(private readonly store: SkillStore) {}

  view(args: ToolArguments): string {
    const name = text(args.name);
    if (!name) return toolError("'skill_view' requires 'name'");
    const skill = this.store.get(name);
    if (skill === undefined) return toolError(`no skill named ${JSON.stringify(name)}`);
    return toolResult(undefined, { name: skill.name, version: skill.version, body: skill.body });
  }

  manage(args: ToolArguments): string {
    const action = args.action;
    const name = text(args.name);
    if (!name) return toolError("'skill_manage' requires 'name'");
    try {
      if (action === "create") {
        const description = text(args.description) ?? "";
        const body = text(args.body) ?? "";
        if (!body) return toolError("'create' requires 'body'");
        const scope = text(args.scope) ?? "home";
        const skill = this.store.create(name, description, body, "1.0.0", scope);
        return toolResult(undefined, { action: "create", name: skill.name, scope });
      }
      if (action === "update") {
        const description = text(args.description);
        const body = text(args.body);
        if (description === null && body === null) {
          return toolError("'update' requires 'description' or 'body'");
        }
        const skill = this.store.update(name, {
          ...(description === null ? {} : { description }),
          ...(body === null ? {} : { body }),
        });
        return toolResult(undefined, { action: "update", name: skill.name });
      }
      if (action === "delete") {
        if (!this.store.delete(name)) return toolError(`no skill named ${JSON.stringify(name)}`);
        return toolResult(undefined, { action: "delete", name });
      }
      const cited = action === undefined ? "undefined" : JSON.stringify(action);
      return toolError(`unknown action ${cited} (use create/update/delete)`);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }
}

export interface SearchRepository {
  searchMessages(query: string, limit?: number): readonly Readonly<Record<string, unknown>>[];
  listSessions(options?: {
    readonly limit?: number;
    readonly includeArchived?: boolean;
  }): readonly Readonly<Record<string, unknown>>[];
  loadMessages(
    sessionId: string,
    activeOnly?: boolean,
  ): readonly Readonly<Record<string, unknown>>[];
}

export class SessionSearchTool {
  constructor(private readonly repository: SearchRepository) {}

  handle(args: ToolArguments): string {
    const mode = args.mode;
    if (mode === "discovery") {
      const query = text(args.query);
      if (!query) return toolError("'discovery' requires 'query'");
      const rawLimit = args.limit ?? 10;
      const limit = Number.isFinite(Number(rawLimit)) ? Math.trunc(Number(rawLimit)) : 10;
      return toolResult(undefined, { hits: this.repository.searchMessages(query, limit) });
    }
    if (mode === "browse") {
      return toolResult(undefined, { sessions: this.repository.listSessions() });
    }
    if (mode === "read") {
      const sessionId = text(args.session_id);
      if (!sessionId) return toolError("'read' requires 'session_id'");
      return toolResult(undefined, { messages: this.repository.loadMessages(sessionId) });
    }
    const cited = mode === undefined ? "undefined" : JSON.stringify(mode);
    return toolError(`unknown mode ${cited} (use discovery/browse/read)`);
  }
}

type CatalogBuilder = typeof buildCatalog;
type TierLoader = (path: string) => TierMap;

function coerceLimit(raw: unknown): { readonly value: number; readonly note: string | null } {
  if (raw === undefined || raw === null) return { value: 25, note: null };
  let value: number | null = null;
  if (typeof raw === "number" && Number.isInteger(raw)) value = raw;
  if (typeof raw === "string" && /^\s*[+-]?\d+\s*$/u.test(raw)) value = Number(raw);
  if (value === null) {
    return { value: 25, note: `limit ${JSON.stringify(raw)} is not a whole number \u2014 used 25` };
  }
  return { value: Math.max(1, Math.min(100, value)), note: null };
}

function renderProvider(
  entry: ProviderModels,
  query: string,
  limit: number,
): Record<string, unknown> {
  const scanned = entry.total;
  const models = query
    ? entry.models.filter((model) => model.toLowerCase().includes(query))
    : entry.models;
  const total = query ? models.length : entry.total;
  const payload: Record<string, unknown> = {
    provider: entry.provider,
    source: entry.source,
    total,
    models: models.slice(0, limit),
    ...(entry.detail ? { detail: entry.detail } : {}),
  };
  const notes: string[] = [];
  if (query && scanned)
    notes.push(`${String(total)} of ${String(scanned)} matched ${JSON.stringify(query)}`);
  if (total > Math.min(models.length, limit)) {
    notes.push(
      `showing ${String(Math.min(models.length, limit))} of ${String(total)} \u2014 refine with 'query' or raise 'limit'`,
    );
  }
  if (notes.length > 0) payload.note = `${entry.provider}: ${notes.join("; ")}`;
  return payload;
}

export class ListModelsTool {
  constructor(
    private readonly home: string,
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly builder: CatalogBuilder = buildCatalog,
    private readonly tierLoader: TierLoader = loadTiers,
  ) {}

  async handle(args: ToolArguments): Promise<string> {
    const provider = (text(args.provider) ?? "").trim();
    const query = (text(args.query) ?? "").trim().toLowerCase();
    const limit = coerceLimit(args.limit);
    let catalog: Catalog;
    try {
      catalog = await this.builder({
        environment: this.environment,
        providers: provider ? [provider] : undefined,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      return toolError(`could not read the model catalog (${name})`);
    }
    if (provider && catalog.entries.length === 0) {
      return toolError(
        `unknown provider ${JSON.stringify(provider)} \u2014 call list_models with no 'provider' to see the ones this install knows about`,
      );
    }
    const tiers = this.tierLoader(join(this.home, "workflow_tiers.json"));
    const renderedTiers: Record<string, unknown> = {};
    for (const name of MODEL_TIERS) renderedTiers[name] = tiers[name] ?? null;
    return toolResult(undefined, {
      providers: catalog.entries.map((entry) => renderProvider(entry, query, limit.value)),
      tiers: renderedTiers,
      ...(limit.note === null ? {} : { note: limit.note }),
    });
  }
}
