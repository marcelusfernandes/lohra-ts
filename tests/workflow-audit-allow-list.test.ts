// Issue #386: SAFE_EVENT_TYPES (audit-model.ts) não pode listar
// node.started/completed/failed/output — nenhum produtor deste código os
// emite; o estado/falha de um nó vive em workflow.node/workflow.fault, a
// pausa em node.paused (decisão #368). Arquivo próprio (não
// workflow-audit-live.test.ts) para não fazer um arquivo já acima de 800
// linhas na base crescer (regra `arquivo-grande` do check `contratos`).
import { describe, expect, it } from "vitest";
import { publicAuditEvent } from "../src/workflow/audit-model.js";
import * as transports from "../src/transports/index.js";

describe("T17 metadata-only audit — allow-list sem produtor", () => {
  it("treats a removed node.* type as unknown, not as a valid event_type", () => {
    // node.started/completed/failed/output nunca tiveram produtor e saíram
    // da allow-list — o sanitizer precisa tratá-los exatamente como trata
    // qualquer outra string desconhecida, nunca aceitá-los como estão.
    const event = publicAuditEvent("r", 1, { event_type: "node.started" }, 1);
    expect(event.event_type).toBe("audit.unavailable");
  });

  // Issue #398 (M8-3, épico #396): error_kind alinhado a ERROR_KIND_SET
  // (`src/transports/error-kinds.ts`, #397) — um valor do vocabulário
  // preserva; string livre continua marcador de exclusão.
  it("preserves a leaf.failed error_kind from the ErrorKind vocabulary", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "leaf.failed", payload: { status: "failed", error_kind: "auth_failed" } },
      1,
    );
    expect(event.data.error_kind).toBe("auth_failed");
  });

  it("redacts a leaf.failed error_kind outside the ErrorKind vocabulary", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "leaf.failed", payload: { status: "failed", error_kind: "qualquer" } },
      1,
    );
    expect(event.data.error_kind).toEqual({ state: "excluded_by_policy", characters: 8 });
  });

  // Issue #426 (M10-S5): route_fault é o 5º valor de node.paused's reason
  // (checkpoint/quota_exhausted/token_budget_exhausted/user_requested); sem
  // este `it`, a entrada nova em SAFE_STRING_VALUES.reason não tinha oráculo
  // — o revisor pediu na 3ª emenda.
  it("preserves node.paused reason 'route_fault' — never excluded_by_policy", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "node.paused", payload: { reason: "route_fault" } },
      1,
    );
    expect(event.data.reason).toBe("route_fault");
  });

  it("accepts exactly the ErrorKind vocabulary for error_kind", () => {
    for (const kind of transports.ERROR_KINDS) {
      const event = publicAuditEvent(
        "r",
        1,
        { event_type: "leaf.failed", payload: { status: "failed", error_kind: kind } },
        1,
      );
      expect(event.data.error_kind).toBe(kind);
    }
  });
});
