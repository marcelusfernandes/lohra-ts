import type Database from "better-sqlite3";

import { AuditRepository } from "../state/audit-repository.js";
import { createBuiltinRegistry } from "../tools/builtins.js";
import type { ToolRegistry } from "../tools/registry.js";
import { workflowAuditHandler } from "../workflow/tool.js";

/** Build the registry that is exposed by the public chat composition root. */
export function createChatToolRegistry(
  database: Database.Database,
  environment: Readonly<Record<string, string | undefined>>,
): ToolRegistry {
  const auditRepository = new AuditRepository(database, { environment });
  return createBuiltinRegistry({
    workflow_audit: workflowAuditHandler(auditRepository),
  });
}
