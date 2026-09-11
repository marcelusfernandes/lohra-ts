// Issue #386: SAFE_EVENT_TYPES (audit-model.ts) não pode listar
// node.started/completed/failed/output — nenhum produtor deste código os
// emite; o estado/falha de um nó vive em workflow.node/workflow.fault, a
// pausa em node.paused (decisão #368). Arquivo próprio (não
// workflow-audit-live.test.ts) para não fazer um arquivo já acima de 800
// linhas na base crescer (regra `arquivo-grande` do check `contratos`).
import { describe, expect, it } from "vitest";
import { publicAuditEvent } from "../src/workflow/audit-model.js";

describe("T17 metadata-only audit — allow-list sem produtor", () => {
  it("treats a removed node.* type as unknown, not as a valid event_type", () => {
    // node.started/completed/failed/output nunca tiveram produtor e saíram
    // da allow-list — o sanitizer precisa tratá-los exatamente como trata
    // qualquer outra string desconhecida, nunca aceitá-los como estão.
    const event = publicAuditEvent("r", 1, { event_type: "node.started" }, 1);
    expect(event.event_type).toBe("audit.unavailable");
  });
});
