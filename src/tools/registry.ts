import { toolError } from "./envelope.js";
import type {
  ToolCheck,
  ToolDefinition,
  ToolEntry,
  ToolHandler,
  ToolKwargs,
  ToolRegistration,
} from "./types.js";

const CHECK_TTL_SECONDS = 30;

interface CheckCache {
  readonly at: number;
  readonly result: boolean;
}

function frozenClone<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) return;
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(clone);
  return clone;
}

export class ToolRegistrationCollisionError extends Error {}

export class ToolRegistry {
  readonly #entries = new Map<string, ToolEntry>();
  #generation = 0;
  #checkCache = new WeakMap<ToolCheck, CheckCache>();

  constructor(private readonly clock: () => number = () => performance.now() / 1000) {}

  get generation(): number {
    return this.#generation;
  }

  register(registration: ToolRegistration): void {
    const next = new Map(this.#entries);
    this.#registerInto(next, registration, false);
    this.#replaceEntries(next);
  }

  registerBatch(
    registrations: readonly ToolRegistration[],
    options: { readonly replaceToolsets?: readonly string[] } = {},
  ): void {
    const next = new Map(this.#entries);
    const replaced = new Set(options.replaceToolsets ?? []);
    if (replaced.size > 0) {
      for (const [name, entry] of next) {
        if (replaced.has(entry.toolset)) next.delete(name);
      }
    }
    const names = new Set<string>();
    for (const registration of registrations) {
      if (names.has(registration.name)) {
        throw new ToolRegistrationCollisionError(
          `tool '${registration.name}' appears more than once in the registration batch`,
        );
      }
      names.add(registration.name);
      this.#registerInto(next, registration, true);
    }
    this.#replaceEntries(next);
  }

  toolsetFor(name: string): string | null {
    return this.#entries.get(name)?.toolset ?? null;
  }

  /** Atomically replaces handlers without changing the public schemas or ownership. */
  overrideHandlers(handlers: Readonly<Record<string, ToolHandler>>): void {
    const next = new Map(this.#entries);
    for (const [name, handler] of Object.entries(handlers)) {
      const existing = next.get(name);
      if (existing === undefined) throw new Error(`cannot override unknown tool '${name}'`);
      next.set(name, Object.freeze({ ...existing, handler }));
    }
    this.#replaceEntries(next);
  }

  #registerInto(
    entries: Map<string, ToolEntry>,
    registration: ToolRegistration,
    strict: boolean,
  ): void {
    const existing = entries.get(registration.name);
    if (strict && existing !== undefined && registration.override !== true) {
      throw new ToolRegistrationCollisionError(
        `tool '${registration.name}' already registered under '${existing.toolset}'`,
      );
    }
    if (existing !== undefined && existing.toolset !== registration.toolset) {
      const bothMcp =
        existing.toolset.startsWith("mcp-") && registration.toolset.startsWith("mcp-");
      if (!bothMcp && registration.override !== true) {
        throw new ToolRegistrationCollisionError(
          `tool '${registration.name}' already registered under '${existing.toolset}'`,
        );
      }
    }
    const schema = frozenClone({ ...registration.schema, name: registration.name });
    entries.set(
      registration.name,
      Object.freeze({
        name: registration.name,
        toolset: registration.toolset,
        schema,
        handler: registration.handler,
        ...(registration.checkFn === undefined ? {} : { checkFn: registration.checkFn }),
        requiresEnv: Object.freeze([...(registration.requiresEnv ?? [])]),
        isAsync: registration.isAsync ?? false,
        description:
          registration.description ??
          (typeof registration.schema.description === "string"
            ? registration.schema.description
            : ""),
        emoji: registration.emoji ?? "⚡",
        maxResultSizeChars: registration.maxResultSizeChars ?? null,
      }),
    );
  }

  #replaceEntries(entries: ReadonlyMap<string, ToolEntry>): void {
    this.#entries.clear();
    for (const [name, entry] of entries) this.#entries.set(name, entry);
    this.#bump();
  }

  deregister(name: string): void {
    if (this.#entries.delete(name)) this.#bump();
  }

  namesInToolset(toolset: string): readonly string[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.toolset === toolset)
      .map((entry) => entry.name);
  }

  getDefinitions(enabled?: ReadonlySet<string> | null): readonly ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const entry of this.#entries.values()) {
      if (enabled !== undefined && enabled !== null && !enabled.has(entry.toolset)) continue;
      if (!this.#isAvailable(entry)) continue;
      definitions.push(
        frozenClone({
          type: "function" as const,
          function: { ...entry.schema },
        }),
      );
    }
    return Object.freeze(definitions);
  }

  async dispatch(
    name: string,
    args: Readonly<Record<string, unknown>>,
    kwargs?: ToolKwargs,
  ): Promise<string> {
    const entry = this.#entries.get(name);
    if (entry === undefined) return toolError(`Unknown tool: ${name}`);
    try {
      return await entry.handler(args, kwargs);
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Tool execution failed: ${name}: ${message}`);
    }
  }

  #bump(): void {
    this.#generation += 1;
    this.#checkCache = new WeakMap<ToolCheck, CheckCache>();
  }

  #isAvailable(entry: ToolEntry): boolean {
    if (entry.checkFn === undefined) return true;
    const now = this.clock();
    const cached = this.#checkCache.get(entry.checkFn);
    if (cached !== undefined && now - cached.at < CHECK_TTL_SECONDS) return cached.result;
    let result: boolean;
    try {
      result = entry.checkFn();
    } catch {
      result = false;
    }
    this.#checkCache.set(entry.checkFn, { at: now, result });
    return result;
  }
}

export const registry = new ToolRegistry();
