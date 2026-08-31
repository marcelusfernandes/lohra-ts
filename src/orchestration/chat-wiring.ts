import type { ToolHandler } from "../tools/types.js";
import type { OrchestrationCore } from "./core.js";
import { collectSessionTool, delegateTaskTool, spawnSessionTool, steerSessionTool } from "./tools.js";
import type { ProviderResolver } from "./tools.js";

/**
 * The four intercepts that replace commands/chat.ts's FAIL_SAFE_HANDLERS
 * entries for spawn_session/steer_session/collect_session/delegate_task via
 * composeDispatch — kept as a pure, injectable-dependency function (not
 * inlined into chat.ts) specifically so this wiring is unit-testable without
 * exercising the whole chat command (no live network, no filesystem).
 */
export function orchestrationToolHandlers(
  core: OrchestrationCore,
  clientPool: ProviderResolver,
): Readonly<Record<string, ToolHandler>> {
  return {
    spawn_session: (args) => spawnSessionTool(core, clientPool, args),
    steer_session: (args) => steerSessionTool(core, args),
    collect_session: (args) => collectSessionTool(core, args),
    delegate_task: (args) => delegateTaskTool(core, args),
  };
}
