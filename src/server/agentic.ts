/** Agentic mode — an opt-in server-side tool allow-list (mirrors
 * `lohra/server/agentic.py`). Exposing tools over HTTP is remote code
 * execution risk, so this is off by default (relay mode). The second guard
 * layer reuses `src/tools/child.ts`, whose T19 parity rule is a deny-list
 * (`parent - E`): intercepted tools (memory/skills/session_search/
 * delegate_task/...) are unreachable and dangerous shell commands are
 * auto-denied. With today's 24 builtins this yields the same five names as
 * the former closed allow-list, but future builtins are fail-open unless
 * added to E. `serve` does not currently register MCP servers; if it ever
 * does, non-excluded MCP tools also become candidates for HTTP exposure.
 * The server's own `--tools` allow-list still gates EXECUTION, not just what
 * the model sees: a tool named by the model (or hallucinated, or
 * client-injected) that wasn't exposed is refused before these guards run. */

import {
  builtinRegistry,
  childToolDefinitions,
  createChildDispatch,
  RegistryToolDispatcher,
  toolError,
  type ToolArguments,
  type ToolDefinition,
} from "../tools/index.js";
import type { ToolDispatcher } from "../conversation/index.js";

/** No `--tools`: relay mode, no tool loop expected. */
export const RELAY_MAX_ITERATIONS = 8;
/** `--tools <allow-list>`: agentic mode, a full tool round-trip loop. */
export const AGENTIC_MAX_ITERATIONS = 90;

export interface AllowedTools {
  readonly definitions: readonly ToolDefinition[];
  readonly dispatcher: ToolDispatcher;
  readonly names: readonly string[];
}

export function buildAllowedTools(allowedNames: readonly string[]): AllowedTools {
  const allowedSet = new Set(allowedNames);
  const safeDefinitions = childToolDefinitions(builtinRegistry.getDefinitions());
  const definitions = safeDefinitions.filter((definition) => allowedSet.has(definition.function.name));
  const exposed = new Set(definitions.map((definition) => definition.function.name));
  const guarded = createChildDispatch(builtinRegistry.dispatch.bind(builtinRegistry));

  async function dispatch(name: string, args: ToolArguments): Promise<string> {
    if (!exposed.has(name)) return toolError(`tool '${name}' is not in the server allow-list`);
    return guarded(name, args);
  }

  return {
    definitions,
    dispatcher: new RegistryToolDispatcher(dispatch),
    names: [...exposed],
  };
}
