import type { MCPServerConfig } from "./config.js";

/**
 * Async view of a connected MCP server. TS needs no Python-style
 * thread-bridge to a private event loop (`ThreadedMCPSession`) -- native
 * async/await already gives every caller (`MCPManager`, the registry's
 * async dispatch) a non-blocking session. See contract-t19 R4.
 */
export interface MCPSession {
  listTools(): Promise<readonly unknown[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
}

export type SessionFactory = (config: MCPServerConfig) => Promise<MCPSession>;

/**
 * `@modelcontextprotocol/sdk` is not a dependency of this package -- mirrors
 * the oracle's `pyproject.toml` `[project.optional-dependencies]` `mcp`
 * extra, not installed in the pinned `.oracle-venv` (baseline M1). Per
 * contract-t19 R4/decision 5, the live stdio/http SDK path is NOT MEASURED
 * and this contract does not authorize building unverified real-SDK wiring
 * here -- only the transport seam (this module's exported connectors,
 * injectable via `SessionFactory`) needs to exist and fail the way the
 * oracle's does in the reference environment. These connectors do not
 * attempt a dynamic import: nothing here should behave differently if the
 * package happens to be present in some other environment, since no real
 * client construction against it has been written or verified.
 */
function sdkNotInstalledError(): Error {
  return new Error("the mcp SDK is not installed; run `npm install @modelcontextprotocol/sdk`");
}

export function connectStdioSession(_config: MCPServerConfig): Promise<MCPSession> {
  return Promise.reject(sdkNotInstalledError());
}

export function connectHttpSession(_config: MCPServerConfig): Promise<MCPSession> {
  return Promise.reject(sdkNotInstalledError());
}

export interface ConnectSessionOptions {
  readonly stdio?: (config: MCPServerConfig) => Promise<MCPSession>;
  readonly http?: (config: MCPServerConfig) => Promise<MCPSession>;
}

/** Route a config to the connector for its transport and reject unknown
 * runtime values explicitly, mirroring the oracle instead of falling through
 * to HTTP when an untyped caller constructs a config by hand. */
export function connectSession(
  config: MCPServerConfig,
  options: ConnectSessionOptions = {},
): Promise<MCPSession> {
  const stdio = options.stdio ?? connectStdioSession;
  const http = options.http ?? connectHttpSession;
  const transport: unknown = config.transport;
  if (transport === "stdio") return stdio(config);
  if (transport === "http") return http(config);
  const cited = transport === undefined ? "undefined" : JSON.stringify(transport);
  return Promise.reject(new Error(`MCP transport ${cited} not supported`));
}

/**
 * Mutable indirection point `registerConfiguredMcpServers` reads its default
 * `sessionFactory` from. ES module named exports are read-only bindings from
 * outside the defining module, so a harness cannot reassign `connectSession`
 * itself the way the oracle's `mcp_fixture.py` reassigns
 * `lohra.mcp.session.connect_session` as a plain module attribute. A
 * `node --import <loader>` script can still mutate this object's `current`
 * property before `dist/cli.js` runs, since both resolve the same cached
 * module instance -- the same "patch shared state before construction, never
 * touch product source" precedent as T18's `t18-mutant-loader.mjs`.
 */
export const defaultSessionFactory: { current: SessionFactory } = {
  current: connectSession,
};
