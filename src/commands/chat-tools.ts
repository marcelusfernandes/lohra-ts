import type Database from "better-sqlite3";

import { AuditRepository } from "../state/audit-repository.js";
import { createBuiltinRegistry } from "../tools/builtins.js";
import type { ToolRegistry } from "../tools/registry.js";
import { workflowAuditHandler } from "../workflow/tool.js";

/** Build the registry that is exposed by the public chat composition root.
 * Issue #380: `AuditRepository` used to get no `warning` at all here, so a
 * fence refusal against this registry's own repository was unobservable —
 * defaults to console.warn, matching the same sink `createSessionToolBase`
 * (`session-tools.ts`) and `WorkflowService` itself fall back to. */
export function createChatToolRegistry(
  database: Database.Database,
  environment: Readonly<Record<string, string | undefined>>,
  warning: (message: string) => void = (message) => {
    console.warn(message);
  },
): ToolRegistry {
  const auditRepository = new AuditRepository(database, { environment, warning });
  return createBuiltinRegistry({
    workflow_audit: workflowAuditHandler(auditRepository),
  });
}

function createFailSafeChatToolRegistry(
  database: Database.Database,
  environment: Readonly<Record<string, string | undefined>>,
): ToolRegistry {
  void database;
  void environment;
  return createBuiltinRegistry();
}

export const CHAT_TOOL_REGISTRY_FACTORIES = Object.freeze({
  public: createChatToolRegistry,
  failSafe: createFailSafeChatToolRegistry,
});
