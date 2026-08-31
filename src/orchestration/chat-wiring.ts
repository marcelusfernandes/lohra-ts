import { randomUUID } from "node:crypto";

import type { ClientPool } from "../agent/client-pool.js";
import type { ConversationRuntimeOptions } from "../conversation/index.js";
import type { SessionRepository } from "../state/index.js";
import type { RegistryDispatch, ToolDefinition, ToolHandler } from "../tools/types.js";
import { createChildRunner } from "./child-runner.js";
import { OrchestrationCore } from "./core.js";
import type { FanoutResolution } from "./fanout-config.js";
import { buildSubagentSystemPrompt } from "./subagent-prompt.js";
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

export interface BuildOrchestrationCoreOptions {
  readonly fanout: FanoutResolution;
  readonly sessions: SessionRepository;
  readonly parentSessionId: string;
  readonly clientPool: ClientPool;
  readonly baseDispatch: RegistryDispatch;
  readonly parentToolDefinitions: readonly ToolDefinition[];
  readonly defaultModel: string;
  readonly cwd: string;
  /** commands/chat.ts's loadPriceOverrides(pricing.json) — forwarded to
   * every child's own ConversationRuntime so an operator's price override
   * applies to a child's persisted cost the same way it applies to the
   * parent's. */
  readonly pricingOverrides?: ConversationRuntimeOptions["pricingOverrides"];
}

/**
 * Builds the real OrchestrationCore commands/chat.ts wires in — extracted
 * (like orchestrationToolHandlers above) so this exact construction path,
 * including how fanout.maxParallel/maxSubsessions reach ConcurrencyGate, is
 * unit-testable from outside chat.ts's closure. A hardcode reintroduced at
 * the chat.ts call site (passing a literal instead of fanout.maxParallel)
 * would only have been caught by a manual CLI smoke test before this;
 * that's not a regression test that runs in CI.
 */
export function buildOrchestrationCore(options: BuildOrchestrationCoreOptions): OrchestrationCore {
  return new OrchestrationCore({
    runChild: createChildRunner({
      sessions: options.sessions,
      parentSessionId: options.parentSessionId,
      clientPool: options.clientPool,
      baseDispatch: options.baseDispatch,
      parentToolDefinitions: options.parentToolDefinitions,
      defaultModel: options.defaultModel,
      cwd: options.cwd,
      idSource: () => randomUUID().replaceAll("-", ""),
      clock: () => Date.now() / 1000,
      childMaxIterations: 50,
      pricingOverrides: options.pricingOverrides,
    }),
    idSource: () => randomUUID().replaceAll("-", ""),
    maxSubsessions: options.fanout.maxSubsessions,
    maxParallel: options.fanout.maxParallel,
    buildSubagentPrompt: () => buildSubagentSystemPrompt(),
  });
}
