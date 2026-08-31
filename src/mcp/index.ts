import { loadMcpConfig, MCPConfigError } from "./config.js";
import { MCPManager } from "./manager.js";
import { connectSession } from "./session.js";
import type { SessionFactory } from "./session.js";
import type { ToolRegistry } from "../tools/registry.js";

export { MCPConfigError, loadMcpConfig } from "./config.js";
export type { MCPServerConfig, MCPTransport } from "./config.js";
export { MCPManager } from "./manager.js";
export {
  connectHttpSession,
  connectSession,
  connectStdioSession,
} from "./session.js";
export type { MCPSession, SessionFactory } from "./session.js";
export {
  convertMcpSchema,
  deregisterServer,
  mcpToolName,
  registerServerTools,
  wrapCallResult,
} from "./tools.js";
export type { CallTool } from "./tools.js";

/** Bare stderr line, no level prefix -- mirrors the oracle's
 * `logging.lastResort` (M2). */
function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface RegisterConfiguredMcpServersOptions {
  readonly configPath: string;
  readonly sessionFactory?: SessionFactory;
}

/**
 * Load `mcp.json` and connect its servers, registering their tools.
 *
 * Returns the live `MCPManager` (call `shutdown()` to clean up), or `null`
 * when there is nothing to do (no config file / no servers) or the config
 * is malformed. Best-effort -- never throws into the caller.
 */
export async function registerConfiguredMcpServers(
  registry: ToolRegistry,
  options: RegisterConfiguredMcpServersOptions,
): Promise<MCPManager | null> {
  let configs;
  try {
    configs = loadMcpConfig(options.configPath);
  } catch (error) {
    if (error instanceof MCPConfigError) {
      warn(`ignoring MCP config: ${error.message}`);
      return null;
    }
    throw error;
  }
  if (configs.length === 0) return null;
  const manager = new MCPManager(registry, options.sessionFactory ?? connectSession);
  await manager.connectAll(configs);
  return manager;
}
