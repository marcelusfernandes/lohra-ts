import { detectDangerousCommand } from "./approval.js";
import { toolError } from "./envelope.js";
import type { RegistryDispatch, ToolArguments, ToolDefinition } from "./types.js";

export const CHILD_EXCLUDED_TOOLS = Object.freeze([
  "delegate_task",
  "memory",
  "skill_view",
  "skill_manage",
  "session_search",
  "cronjob",
  "vision_analyze",
  "image_gen",
  "spawn_session",
  "steer_session",
  "collect_session",
  "run_workflow",
  "workflow_status",
  "workflow_audit",
  "workflow_list",
  "workflow_pause",
  "workflow_cancel",
  "workflow_templates",
  "list_models",
] as const);

const excluded = new Set<string>(CHILD_EXCLUDED_TOOLS);

function frozenClone<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) return;
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(clone);
  return clone;
}

/**
 * R1 (T19): child visibility is `parent − E` (the oracle's own deny-list
 * mechanism), not an allow-list intersection. See contract-t19 decision 1 —
 * this supersedes T09's allow-list hardening for visibility computation
 * only; `terminal.command` non-string/dangerous-command guards below are a
 * separate surface, untouched.
 */
export function childToolDefinitions(
  definitions: readonly ToolDefinition[],
): readonly ToolDefinition[] {
  return Object.freeze(
    definitions
      .filter((definition) => !excluded.has(definition.function.name))
      .map((definition) => frozenClone(definition)),
  );
}

export function createChildDispatch(
  base: RegistryDispatch,
): (name: string, args: ToolArguments) => Promise<string> {
  return async (name, args) => {
    if (excluded.has(name)) {
      return toolError(`the '${name}' tool is not available to subagents`);
    }
    if (name === "terminal" && typeof args.command !== "string") {
      return toolError("command was not approved by the user", { command: args.command });
    }
    if (name === "terminal") {
      const command = args.command as string;
      const dangerous = detectDangerousCommand(command);
      if (dangerous !== null) {
        return toolError(`subagent auto-denied a dangerous command (${dangerous.description})`, {
          command,
        });
      }
    }
    return await base(name, args);
  };
}
