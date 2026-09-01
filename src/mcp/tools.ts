import { pythonRepr } from "../serialization/python-repr.js";
import { toolError, toolResult } from "../tools/envelope.js";
import {
  ToolRegistrationCollisionError,
  type ToolRegistry,
} from "../tools/registry.js";
import type { ToolFunctionSchema, ToolHandler } from "../tools/types.js";

const EMPTY_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: {},
});

const INVALID = /[^a-z0-9]+/g;

/** Deterministic registry name: `mcp_{server}_{tool}` (sanitized, lowercase). */
export function mcpToolName(server: string, tool: string): string {
  const serverSlug = server.toLowerCase().replaceAll(INVALID, "_").replace(/^_+|_+$/g, "");
  const toolSlug = tool.toLowerCase().replaceAll(INVALID, "_").replace(/^_+|_+$/g, "");
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
    description: typeof description === "string" ? description : "",
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
  const blocks = field<readonly unknown[]>(result, "content", []);
  const parts: string[] = [];
  for (const block of blocks) {
    if (field<unknown>(block, "type", undefined) === "text") {
      const text = field<unknown>(block, "text", "");
      parts.push(typeof text === "string" ? text : "");
    } else {
      parts.push(`[${String(field<unknown>(block, "type", "content"))} block]`);
    }
  }
  const text = parts.join("");
  if (field<unknown>(result, "isError", false)) {
    return toolError(text || "MCP tool reported an error");
  }
  return toolResult(undefined, { content: text });
}

export type CallTool = (originalName: string, args: Readonly<Record<string, unknown>>) => unknown;

function makeHandler(callTool: CallTool, originalName: string): ToolHandler {
  return async (args) => wrapCallResult(await callTool(originalName, args));
}

/** Bare stderr line, no level prefix -- mirrors the oracle's
 * `logging.lastResort` (M2): no `WARNING:`, no logger name, no timestamp. */
function warn(message: string): void {
  process.stderr.write(`${message}\n`);
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
  const toolset = `mcp-${server}`;
  const registered: string[] = [];
  for (const tool of tools) {
    const original = field<unknown>(tool, "name", undefined);
    if (typeof original !== "string" || original === "") continue;
    const name = mcpToolName(server, original);
    if (registered.includes(name)) {
      warn(`MCP tool ${pythonRepr(server)}/${pythonRepr(original)} collides with an earlier tool as ${pythonRepr(name)} — skipped`);
      continue;
    }
    try {
      registry.register({
        name,
        toolset,
        schema: convertMcpSchema(tool),
        handler: makeHandler(callTool, original),
        emoji: "🔌",
      });
    } catch (error) {
      if (!(error instanceof ToolRegistrationCollisionError)) throw error;
      warn(`MCP tool ${pythonRepr(original)} shadows an existing ${pythonRepr(name)} — skipped`);
      continue;
    }
    registered.push(name);
  }
  return registered;
}

/** Nuke-and-repave: drop every tool a server registered (for refresh/shutdown). */
export function deregisterServer(registry: ToolRegistry, server: string): void {
  for (const name of registry.namesInToolset(`mcp-${server}`)) registry.deregister(name);
}
