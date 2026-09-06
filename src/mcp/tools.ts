import { hasJsonValue } from "../serialization/json-presence.js";
import { toolError, toolResult } from "../tools/envelope.js";
import { ToolRegistrationCollisionError, type ToolRegistry } from "../tools/registry.js";
import type { ToolFunctionSchema, ToolHandler } from "../tools/types.js";
import type { ToolRegistration } from "../tools/types.js";

const EMPTY_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: {},
});

const INVALID = /[^a-z0-9]+/g;

/** `JSON.stringify` is typed to always return `string`, but at runtime
 * returns the JS value `undefined` for a function, a symbol, or `undefined`
 * itself — this widens the type so callers can cite that case explicitly. */
function jsonStringifyOrUndefined(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/** Deterministic registry name: `mcp_{server}_{tool}` (sanitized, lowercase). */
export function mcpToolName(server: string, tool: string): string {
  const serverSlug = server
    .toLowerCase()
    .replaceAll(INVALID, "_")
    .replace(/^_+|_+$/g, "");
  const toolSlug = tool
    .toLowerCase()
    .replaceAll(INVALID, "_")
    .replace(/^_+|_+$/g, "");
  return `mcp_${serverSlug}_${toolSlug}`;
}

function field<T>(obj: unknown, key: string, fallback: T): T {
  if (obj !== null && typeof obj === "object" && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return value === undefined ? fallback : (value as T);
  }
  return fallback;
}

/** MCP tool ({name, description, inputSchema}) -> registry schema. Never
 * trusts the server's schema: a non-object `inputSchema` would poison the
 * whole tools array sent to the provider, so it falls back to the empty
 * object instead. */
export function convertMcpSchema(tool: unknown): ToolFunctionSchema {
  const parameters = field<unknown>(tool, "inputSchema", undefined);
  const description = field<unknown>(tool, "description", "");
  return {
    description: hasJsonValue(description) ? description : "",
    parameters:
      parameters !== null && typeof parameters === "object" && !Array.isArray(parameters)
        ? (parameters as Readonly<Record<string, unknown>>)
        : EMPTY_SCHEMA,
  };
}

export interface MCPCallToolResult {
  readonly content?: readonly unknown[];
  readonly isError?: boolean;
}

/** MCP CallToolResult (dict or SDK-shaped object) -> JSON envelope string. */
export function wrapCallResult(result: unknown): string {
  const blocks = field<unknown>(result, "content", []);
  if (!Array.isArray(blocks)) {
    throw new TypeError("MCP result content must be an array of blocks");
  }
  const parts: unknown[] = [];
  for (const block of blocks) {
    if (field<unknown>(block, "type", undefined) === "text") {
      const text = field<unknown>(block, "text", "");
      parts.push(hasJsonValue(text) ? text : "");
    } else {
      const type = field<unknown>(block, "type", "content");
      // JSON.stringify returns the JS value `undefined` (not a string) for a
      // function/symbol/undefined `type` — cited as the literal `undefined`
      // explicitly, never left to template-literal coercion.
      const rendered =
        typeof type === "string" || typeof type === "number"
          ? String(type)
          : (jsonStringifyOrUndefined(type) ?? "undefined");
      parts.push(`[${rendered} block]`);
    }
  }
  const invalidIndex = parts.findIndex((part) => typeof part !== "string");
  if (invalidIndex >= 0) {
    throw new TypeError(`MCP text block ${String(invalidIndex)} must contain a string`);
  }
  const text = parts.join("");
  if (field<unknown>(result, "isError", false)) {
    return toolError(text || "MCP tool reported an error");
  }
  return toolResult(undefined, { content: text });
}

export type CallTool = (originalName: string, args: Readonly<Record<string, unknown>>) => unknown;

export class MCPToolListError extends Error {}

export class MCPToolNameCollisionError extends Error {
  override readonly cause = "MCP_TOOL_NAME_COLLISION";
  readonly toolName: string;

  constructor(toolName: string) {
    super(`MCP tool name collision: ${toolName}`);
    this.name = "MCPToolNameCollisionError";
    this.toolName = toolName;
  }
}

function makeHandler(callTool: CallTool, originalName: string): ToolHandler {
  return async (args) => wrapCallResult(await callTool(originalName, args));
}

/** Bare stderr line, no level prefix -- mirrors the oracle's
 * `logging.lastResort` (M2): no `WARNING:`, no logger name, no timestamp. */
function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface PreparedMcpTools {
  readonly names: readonly string[];
  readonly registrations: readonly ToolRegistration[];
}

export function prepareServerTools(
  server: string,
  tools: readonly unknown[],
  callTool: CallTool,
): PreparedMcpTools {
  const toolset = `mcp-${server}`;
  const names = new Set<string>();
  const registrations: ToolRegistration[] = [];
  for (const tool of tools) {
    const original = field<unknown>(tool, "name", undefined);
    if (!hasJsonValue(original)) continue;
    if (typeof original !== "string") {
      throw new MCPToolListError(
        `MCP server ${JSON.stringify(server)} returned a truthy non-string tool name: ${JSON.stringify(original)}`,
      );
    }
    const name = mcpToolName(server, original);
    if (names.has(name)) throw new MCPToolNameCollisionError(name);
    names.add(name);
    registrations.push({
      name,
      toolset,
      schema: convertMcpSchema(tool),
      handler: makeHandler(callTool, original),
      emoji: "🔌",
    });
  }
  return { names: [...names], registrations };
}

/** Register every tool of one MCP server. Returns the registry names added.
 * A name that collides with a non-MCP (builtin) tool is skipped, not fatal
 * -- the builtin keeps the name. */
export function registerServerTools(
  registry: ToolRegistry,
  server: string,
  tools: readonly unknown[],
  callTool: CallTool,
): readonly string[] {
  const prepared = prepareServerTools(server, tools, callTool);
  const registrations = prepared.registrations.filter((registration) => {
    const existingToolset = registry.toolsetFor(registration.name);
    if (existingToolset === null) return true;
    if (!existingToolset.startsWith("mcp-")) {
      warn(
        `MCP tool ${JSON.stringify(registration.name)} shadows an existing ${JSON.stringify(registration.name)} — skipped`,
      );
      return false;
    }
    throw new MCPToolNameCollisionError(registration.name);
  });
  try {
    registry.registerBatch(registrations);
  } catch (error) {
    if (error instanceof ToolRegistrationCollisionError) {
      const name = registrations.find(
        (registration) => registry.toolsetFor(registration.name) !== null,
      )?.name;
      throw new MCPToolNameCollisionError(name ?? "unknown");
    }
    throw error;
  }
  return registrations.map(({ name }) => name);
}

/** Nuke-and-repave: drop every tool a server registered (for refresh/shutdown). */
export function deregisterServer(registry: ToolRegistry, server: string): void {
  for (const name of registry.namesInToolset(`mcp-${server}`)) registry.deregister(name);
}
