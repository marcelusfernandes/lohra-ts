import { existsSync, readFileSync } from "node:fs";

import { hasJsonValue } from "../serialization/json-presence.js";

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

function isCanonicalArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  if (key.length !== 10) return key.length < 10;
  return key <= "4294967294";
}

function mappingKey(name: string, key: unknown, location: string): string {
  const at = location === "" ? "" : ` ${location}`;
  if (key !== null && typeof key !== "string") {
    throw new MCPConfigError(
      `server ${JSON.stringify(name)} field 'env'${at} key must be a non-ambiguous string or null`,
    );
  }
  const coerced = key === null ? "null" : key;
  if (isCanonicalArrayIndex(coerced)) {
    throw new MCPConfigError(
      `server ${JSON.stringify(name)} field 'env'${at} key ${JSON.stringify(coerced)} is a canonical array-index string`,
    );
  }
  return coerced;
}

function defineMappingEntry(mapping: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(mapping, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function mappingFromJson(name: string, value: unknown): Readonly<Record<string, unknown>> {
  const mapping = Object.create(null) as Record<string, unknown>;
  if (isRecord(value)) {
    for (const [key, entryValue] of Object.entries(value)) {
      defineMappingEntry(mapping, mappingKey(name, key, ""), entryValue);
    }
    return mapping;
  }
  if (!Array.isArray(value)) {
    throw new MCPConfigError(
      `server ${JSON.stringify(name)} field 'env' cannot construct a mapping`,
    );
  }

  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const pair: readonly unknown[] | undefined = Array.isArray(entry)
      ? (entry as readonly unknown[])
      : typeof entry === "string"
        ? Array.from(entry)
        : undefined;
    if (pair?.length !== 2) {
      throw new MCPConfigError(
        `server ${JSON.stringify(name)} field 'env' cannot construct a mapping`,
      );
    }
    const key = mappingKey(name, pair[0], `entry ${String(index)}`);
    if (seen.has(key)) {
      throw new MCPConfigError(
        `server ${JSON.stringify(name)} field 'env' entry ${String(index)} collides after key coercion: ${JSON.stringify(key)}`,
      );
    }
    seen.add(key);
    defineMappingEntry(mapping, key, pair[1]);
  }
  return mapping;
}

function argsFromJson(name: string, value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return Array.from(value as readonly unknown[]);
  if (typeof value === "string") return Array.from(value);
  throw new MCPConfigError(`server ${JSON.stringify(name)} field 'args' must be a string or array`);
}

function parseServer(name: string, spec: unknown): MCPServerConfig {
  if (!isRecord(spec)) throw new MCPConfigError(`server ${JSON.stringify(name)} must be an object`);
  if (hasJsonValue(spec.url) && typeof spec.url !== "string") {
    throw new MCPConfigError(`server ${JSON.stringify(name)} field 'url' must be a string`);
  }
  if (hasJsonValue(spec.command) && typeof spec.command !== "string") {
    throw new MCPConfigError(`server ${JSON.stringify(name)} field 'command' must be a string`);
  }
  const url = typeof spec.url === "string" && spec.url ? spec.url : undefined;
  const command = typeof spec.command === "string" && spec.command ? spec.command : undefined;
  if (url !== undefined) {
    return { name, transport: "http", args: [], env: {}, url };
  }
  if (command !== undefined) {
    const rawArgs = spec.args;
    const args = rawArgs === undefined || rawArgs === null ? [] : argsFromJson(name, rawArgs);
    const rawEnv = spec.env;
    const env = rawEnv === undefined || rawEnv === null ? {} : mappingFromJson(name, rawEnv);
    return { name, transport: "stdio", command, args, env };
  }
  throw new MCPConfigError(
    `server ${JSON.stringify(name)} needs a 'command' (stdio) or 'url' (http)`,
  );
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
    if (isRecord(spec) && hasJsonValue(spec.disabled)) continue;
    configs.push(parseServer(name, spec));
  }
  return configs;
}
