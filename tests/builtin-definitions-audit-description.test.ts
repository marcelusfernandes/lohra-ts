// Issue #394: a descrição de `workflow_audit` dizia que `integrity.pending`
// contava "this run's own events" — mas `AuditTrail.pendingCount()`
// (audit-trail.ts:124-126) soma fila + em voo do trail INTEIRO do processo,
// sem filtrar por run_id (fila + escrita em voo de qualquer run que o mesmo
// processo esteja atendendo). O texto precisa dizer isso: contagem do
// processo (qualquer run), não do run consultado; uma leitura de outro
// processo nunca seta o campo. `docs/workflow-audit.md` (seção
// `integrity.pending`, PR #393) já descreve o comportamento certo.
import { describe, expect, it } from "vitest";
import { BUILTIN_DEFINITIONS } from "../src/tools/builtin-definitions.js";

describe("workflow_audit description: integrity.pending is process-wide (#394)", () => {
  const description = (): string => {
    const workflowAudit = BUILTIN_DEFINITIONS.find(
      (definition) => definition.function.name === "workflow_audit",
    );
    if (workflowAudit === undefined) throw new Error("workflow_audit tool not found");
    return workflowAudit.function.description;
  };

  it("describes pending as counting any run in this process's audit trail", () => {
    expect(description()).toContain("any run");
  });

  it("no longer claims pending counts only this run's own events", () => {
    expect(description()).not.toContain("this run's own events");
  });
});
