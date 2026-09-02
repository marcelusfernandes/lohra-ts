/** Agentic mode — an opt-in server-side tool allow-list (mirrors
 * `lohra/server/agentic.py`). Exposing tools over HTTP is remote code
 * execution risk, so this is off by default (relay mode). The exposed tools
 * reuse the existing subagent guards (`src/tools/child.ts`): intercepted
 * tools (memory/skills/session_search/delegate_task/...) are never
 * reachable and dangerous shell commands are auto-denied — there is no
 * operator to approve them over HTTP. On top of that, the server's own
 * `--tools` allow-list gates EXECUTION, not just what the model sees: a
 * tool named by the model (or hallucinated, or client-injected) that
 * wasn't exposed is refused before the subagent guards even run. */

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
