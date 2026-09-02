import type { MCPServerConfig } from "./config.js";
import type { MCPSession, SessionFactory } from "./session.js";
import { deregisterServer, registerServerTools } from "./tools.js";
import { pythonRepr } from "../serialization/python-repr.js";
import type { ToolRegistry } from "../tools/registry.js";

/** Bare stderr line, no level prefix -- mirrors the oracle's
 * `logging.lastResort` (M2). */
function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Owns the live MCP sessions and their registered tools.
 *
 * `refresh` is ported for structural completeness (contract-t19 decision 4)
 * but this ticket wires no product caller for it -- the ticket's own
 * acceptance line claiming "refresh altera registry" was found unreachable
 * by public traversal on the oracle side (baseline M7) and this port
 * deliberately does not add a caller that would make it reachable here
 * either. Evidence for `refresh` is `[processo-ts]`, never principal.
 */
export class MCPManager {
  readonly #registry: ToolRegistry;
  readonly #sessionFactory: SessionFactory;
  readonly #sessions = new Map<string, MCPSession>();

  constructor(registry: ToolRegistry, sessionFactory: SessionFactory) {
    this.#registry = registry;
    this.#sessionFactory = sessionFactory;
  }

  /** Connect and register each server; skip (log) the ones that fail. A
   * connect failure and a list-tools failure share the same "failed to
   * connect" message -- reproduced imprecision (baseline M12), not
   * "corrected" without an ADR. */
  async connectAll(configs: readonly MCPServerConfig[]): Promise<void> {
    for (const config of configs) {
      try {
        await this.#connect(config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(`MCP server ${pythonRepr(config.name)} failed to connect: ${message}`);
      }
    }
  }

  async #connect(config: MCPServerConfig): Promise<void> {
    const session = await this.#sessionFactory(config);
    try {
      const tools = await session.listTools();
      registerServerTools(this.#registry, config.name, tools, (name, args) => session.callTool(name, args));
    } catch (error) {
      await session.close(); // don't leak a session we couldn't register
      throw error;
    }
    this.#sessions.set(config.name, session);
  }

  /** Re-list a server's tools and re-register them (nuke-and-repave). */
  async refresh(server: string): Promise<void> {
    const session = this.#sessions.get(server);
    if (session === undefined) return;
    deregisterServer(this.#registry, server);
    const tools = await session.listTools();
    registerServerTools(this.#registry, server, tools, (name, args) => session.callTool(name, args));
  }

  /** Deregister every server's tools and close all sessions. */
  async shutdown(): Promise<void> {
    for (const [name, session] of this.#sessions) {
      deregisterServer(this.#registry, name);
      try {
        await session.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(`error closing MCP session ${pythonRepr(name)}: ${message}`);
      }
    }
    this.#sessions.clear();
  }
}
