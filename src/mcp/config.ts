import { existsSync, readFileSync } from "node:fs";

import { pythonRepr } from "../serialization/python-repr.js";
import { isPythonTruthy } from "../serialization/python-truthy.js";

/** Raised on a malformed mcp.json (never on a missing file). */
export class MCPConfigError extends Error {}

export type MCPTransport = "stdio" | "http";

export interface MCPServerConfig {
  readonly name: string;
  readonly transport: MCPTransport;
  readonly command?: string;
  readonly args: readonly unknown[];
  readonly env: Readonly<Record<string, unknown>>;
  readonly url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pythonMappingFromJson(name: string, value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) return { ...value };
  if (!Array.isArray(value)) {
    throw new MCPConfigError(`server ${pythonRepr(name)} field 'env' cannot construct a mapping`);
  }

  const mapping: Record<string, unknown> = {};
  for (const entry of value) {
    const pair: readonly unknown[] | undefined = Array.isArray(entry)
      ? (entry as readonly unknown[])
      : typeof entry === "string"
        ? Array.from(entry)
        : undefined;
    if (pair?.length !== 2) {
      throw new MCPConfigError(`server ${pythonRepr(name)} field 'env' cannot construct a mapping`);
    }
    const key = pair[0];
    if (
      key !== null &&
      typeof key !== "string" &&
      typeof key !== "number" &&
      typeof key !== "boolean"
    ) {
      throw new MCPConfigError(`server ${pythonRepr(name)} field 'env' cannot construct a mapping`);
    }
    mapping[String(key)] = pair[1];
  }
  return mapping;
}

function parseServer(name: string, spec: unknown): MCPServerConfig {
  if (!isRecord(spec)) throw new MCPConfigError(`server ${pythonRepr(name)} must be an object`);
  if (isPythonTruthy(spec.url) && typeof spec.url !== "string") {
    throw new MCPConfigError(`server ${pythonRepr(name)} field 'url' must be a string`);
  }
  if (isPythonTruthy(spec.command) && typeof spec.command !== "string") {
    throw new MCPConfigError(`server ${pythonRepr(name)} field 'command' must be a string`);
  }
  const url = typeof spec.url === "string" && spec.url ? spec.url : undefined;
  const command = typeof spec.command === "string" && spec.command ? spec.command : undefined;
  if (url !== undefined) {
    return { name, transport: "http", args: [], env: {}, url };
  }
  if (command !== undefined) {
    const rawArgs = spec.args;
    const args = !isPythonTruthy(rawArgs)
      ? []
      : Array.isArray(rawArgs)
        ? Array.from(rawArgs as readonly unknown[])
        : typeof rawArgs === "string"
          ? Array.from(rawArgs)
          : isRecord(rawArgs)
            ? Object.keys(rawArgs)
            : (() => {
                throw new MCPConfigError(`server ${pythonRepr(name)} field 'args' is not iterable`);
              })();
    const rawEnv = spec.env;
    const env = !isPythonTruthy(rawEnv)
      ? {}
      : pythonMappingFromJson(name, rawEnv);
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
    if (isRecord(spec) && isPythonTruthy(spec.disabled)) continue;
    configs.push(parseServer(name, spec));
  }
  return configs;
}
