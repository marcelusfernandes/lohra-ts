import { existsSync, readFileSync } from "node:fs";

import { pythonRepr } from "../serialization/python-repr.js";

/** Raised on a malformed mcp.json (never on a missing file). */
export class MCPConfigError extends Error {}

export type MCPTransport = "stdio" | "http";

export interface MCPServerConfig {
  readonly name: string;
  readonly transport: MCPTransport;
  readonly command?: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseServer(name: string, spec: unknown): MCPServerConfig {
  if (!isRecord(spec)) throw new MCPConfigError(`server ${pythonRepr(name)} must be an object`);
  const url = typeof spec.url === "string" && spec.url ? spec.url : undefined;
  const command = typeof spec.command === "string" && spec.command ? spec.command : undefined;
  if (url !== undefined) {
    return { name, transport: "http", args: [], env: {}, url };
  }
  if (command !== undefined) {
    const args = Array.isArray(spec.args) ? spec.args.filter((v): v is string => typeof v === "string") : [];
    const env: Record<string, string> = {};
    if (isRecord(spec.env)) {
      for (const [key, value] of Object.entries(spec.env)) {
        if (typeof value === "string") env[key] = value;
      }
    }
    return { name, transport: "stdio", command, args, env };
  }
  throw new MCPConfigError(`server ${pythonRepr(name)} needs a 'command' (stdio) or 'url' (http)`);
}

/** Load enabled MCP server configs. Missing file -> []; malformed -> throws. */
export function loadMcpConfig(path: string): readonly MCPServerConfig[] {
  if (!existsSync(path)) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MCPConfigError(`could not parse ${path}: ${message}`);
  }
  const servers = isRecord(data) ? (data.mcpServers ?? {}) : null;
  if (!isRecord(servers)) throw new MCPConfigError("'mcpServers' must be an object");

  const configs: MCPServerConfig[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (isRecord(spec) && spec.disabled === true) continue;
    configs.push(parseServer(name, spec));
  }
  return configs;
}
