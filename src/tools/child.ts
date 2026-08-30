import { toolError } from "./envelope.js";
import type { RegistryDispatch, ToolArguments, ToolDefinition } from "./types.js";

export const CHILD_TOOL_ALLOWLIST = Object.freeze([
  "read_file",
  "write_file",
  "terminal",
  "web_fetch",
  "web_search",
] as const);

const allowed = new Set<string>(CHILD_TOOL_ALLOWLIST);

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

export function childToolDefinitions(
  definitions: readonly ToolDefinition[],
): readonly ToolDefinition[] {
  return Object.freeze(
    definitions
      .filter((definition) => allowed.has(definition.function.name))
      .map((definition) => frozenClone(definition)),
  );
}

export function createChildDispatch(
  base: RegistryDispatch,
): (name: string, args: ToolArguments) => Promise<string> {
  return async (name, args) => {
    if (!allowed.has(name)) return toolError(`Unknown tool: ${name}`);
    if (name === "terminal" && typeof args.command !== "string") {
      return toolError("command was not approved by the user", { command: args.command });
    }
    return await base(name, args);
  };
}
