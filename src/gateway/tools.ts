import { parseToolArguments } from "../tools/arguments.js";
import { builtinRegistry, composeDispatch, MemoryTool, type ToolRegistry } from "../tools/index.js";
import type { ToolDefinition } from "../tools/types.js";
import { MemoryStore } from "../memory/index.js";

export interface GatewayToolRuntime {
  readonly dispatch: (name: string, argumentsJson: string) => Promise<string>;
  readonly toolNames: readonly string[];
  readonly toolDefinitions: readonly ToolDefinition[];
}

// The gateway is a "parent" surface (unlike T11's subagent), so it gets the
// full dispatch composition -- memory routed to a real MemoryStore/MemoryTool
// instead of the subagent's auto-deny path (L10). No allow-list: all 24
// registry tools are always available, in registry order (assertion 41).
// The dangerous-command gate is left with NO approval callback set, so
// ApprovalManager.require() denies by fail-safe absence of callback,
// producing terminal.ts's exact "command was not approved by the user"
// message -- deliberately different from T11's subagent auto-deny message,
// per assertion 40.
export function createGatewayToolRuntime(
  home: string,
  sessionRegistry?: ToolRegistry,
): GatewayToolRuntime {
  if (sessionRegistry !== undefined) {
    const toolDefinitions = sessionRegistry.getDefinitions();
    return {
      dispatch: (name, argumentsJson) =>
        sessionRegistry.dispatch(name, parseToolArguments(argumentsJson)),
      toolNames: toolDefinitions.map((definition) => definition.function.name),
      toolDefinitions,
    };
  }
  const memoryStore = new MemoryStore(home);
  const memoryTool = new MemoryTool(memoryStore);
  const composed = composeDispatch(builtinRegistry.dispatch.bind(builtinRegistry), {
    memory: (args) => memoryTool.handle(args),
  });
  const toolDefinitions = builtinRegistry.getDefinitions();
  return {
    dispatch: (name, argumentsJson) => composed(name, parseToolArguments(argumentsJson)),
    toolNames: toolDefinitions.map((definition) => definition.function.name),
    toolDefinitions,
  };
}

// tool_id restarts at tool_1 every turn (assertion 38) -- it is scoped to a
// single turn's execution, never persisted across turns or sessions. A
// fresh GatewayToolIdCounter per turn reproduces that exactly.
export class GatewayToolIdCounter {
  #next = 1;

  public nextId(): string {
    const id = `tool_${String(this.#next)}`;
    this.#next += 1;
    return id;
  }
}
