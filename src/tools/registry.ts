import { toolError } from "./envelope.js";
import type {
  ToolCheck,
  ToolDefinition,
  ToolEntry,
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

export class ToolRegistry {
  readonly #entries = new Map<string, ToolEntry>();
  #generation = 0;
  #checkCache = new WeakMap<ToolCheck, CheckCache>();

  constructor(private readonly clock: () => number = () => performance.now() / 1000) {}

  get generation(): number {
    return this.#generation;
  }

  register(registration: ToolRegistration): void {
    const existing = this.#entries.get(registration.name);
    if (existing !== undefined && existing.toolset !== registration.toolset) {
      const bothMcp =
        existing.toolset.startsWith("mcp-") && registration.toolset.startsWith("mcp-");
      if (!bothMcp && registration.override !== true) {
        throw new Error(
          `tool '${registration.name}' already registered under '${existing.toolset}'`,
        );
      }
    }
    const schema = frozenClone({ ...registration.schema, name: registration.name });
    this.#entries.set(
      registration.name,
      Object.freeze({
        name: registration.name,
        toolset: registration.toolset,
        schema,
        handler: registration.handler,
        ...(registration.checkFn === undefined ? {} : { checkFn: registration.checkFn }),
        requiresEnv: Object.freeze([...(registration.requiresEnv ?? [])]),
        isAsync: registration.isAsync ?? false,
        description: registration.description ?? registration.schema.description,
        emoji: registration.emoji ?? "⚡",
        maxResultSizeChars: registration.maxResultSizeChars ?? null,
      }),
    );
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
