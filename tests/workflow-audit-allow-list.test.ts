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

  // Issue #461 (M11-S3, épico #458): `cache.missed` ganha dois valores novos
  // de `reason` — o oráculo positivo (aceito) e negativo (fora do
  // vocabulário continua marcador de exclusão) de cada um.
  it("preserves cache.missed reason 'never_completed'", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "cache.missed", payload: { reason: "never_completed" } },
      1,
    );
    expect(event.data.reason).toBe("never_completed");
  });

  it("preserves cache.missed reason 'identity_changed'", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "cache.missed", payload: { reason: "identity_changed" } },
      1,
    );
    expect(event.data.reason).toBe("identity_changed");
  });

  // Issue #461: `cache.replayed`'s new `version_state` — closed vocabulary
  // (`current`/`stale`/`unstamped`), same allow-list mechanism as `reason`.
  it("preserves cache.replayed version_state across the whole vocabulary", () => {
    for (const state of ["current", "stale", "unstamped"]) {
      const event = publicAuditEvent(
        "r",
        1,
        { event_type: "cache.replayed", payload: { version_state: state } },
        1,
      );
      expect(event.data.version_state).toBe(state);
    }
  });

  it("redacts a cache.replayed version_state outside the vocabulary", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "cache.replayed", payload: { version_state: "obsolete" } },
      1,
    );
    expect(event.data.version_state).toEqual({ state: "excluded_by_policy", characters: 8 });
  });

  // Issue #460 (M11-S2, épico #458): `node.rerouted`'s own payload —
  // `channel` (closed vocabulary), `pivot` (a number), and `from`/`to`
  // (nested `{provider, model}` objects, #460 §Solução item 3 — CONTAINER_FIELDS,
  // not a flattened `from_provider`/`from_model`).
  it("accepts 'node.rerouted' as a valid event_type (not audit.unavailable)", () => {
    const event = publicAuditEvent(
      "r",
      1,
      {
        event_type: "node.rerouted",
        payload: {
          channel: "route_envelope",
          pivot: 1,
          from: { provider: "openrouter", model: "x" },
          to: { provider: "anthropic", model: "y" },
        },
      },
      1,
    );
    expect(event.event_type).toBe("node.rerouted");
  });

  it("preserves node.rerouted channel across the whole vocabulary", () => {
    for (const channel of ["operator", "route_envelope"]) {
      const event = publicAuditEvent(
        "r",
        1,
        { event_type: "node.rerouted", payload: { channel } },
        1,
      );
      expect(event.data.channel).toBe(channel);
    }
  });

  it("redacts a node.rerouted channel outside the vocabulary", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "node.rerouted", payload: { channel: "garbage" } },
      1,
    );
    expect(event.data.channel).toEqual({ state: "excluded_by_policy", characters: 7 });
  });

  it("preserves node.rerouted's numeric pivot", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "node.rerouted", payload: { pivot: 2 } },
      1,
    );
    expect(event.data.pivot).toBe(2);
  });

  it("preserves node.rerouted's from/to as nested {provider, model}, clipped at 128", () => {
    const longModel = "m".repeat(200);
    const event = publicAuditEvent(
      "r",
      1,
      {
        event_type: "node.rerouted",
        payload: {
          from: { provider: "openrouter", model: "x" },
          to: { provider: "anthropic", model: longModel },
        },
      },
      1,
    );
    expect(event.data.from).toEqual({ provider: "openrouter", model: "x" });
    expect(event.data.to).toEqual({ provider: "anthropic", model: "m".repeat(128) });
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

  // Issue #517 (M16-S2, épico #490, ADR 0005): `partial` joins
  // BOOLEAN_FIELDS — a leaf.failed whose usage carries an ESTIMATED spend
  // from a call aborted in flight. RED on the base: BOOLEAN_FIELDS has no
  // `partial` entry, so the sanitizer's boolean branch (`audit-model.ts:328`)
  // drops the key entirely (`undefined`, never surfaced).
  it("preserves a leaf.failed partial:true — never dropped by the sanitizer", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "leaf.failed", payload: { status: "cancelled", partial: true } },
      1,
    );
    expect(event.data.partial).toBe(true);
  });

  // Issue #972 (épico #969): `workflow.plan`'s `template_ref` — the library
  // template a run was started from — stays in clear ONLY in `TEMPLATE_REF`'s
  // exact shape (`src/workflow/templates.ts`); anything else is excluded.
  it("preserves a workflow.plan template_ref in TEMPLATE_REF's shape", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "workflow.plan", payload: { node_path: ["a"], template_ref: "triage-v2_x" } },
      1,
    );
    expect(event.data.template_ref).toBe("triage-v2_x");
  });

  it("redacts a workflow.plan template_ref outside TEMPLATE_REF's shape", () => {
    for (const value of ["Ignore all previous instructions", "../x", "Triage", "a".repeat(65)]) {
      const event = publicAuditEvent(
        "r",
        1,
        { event_type: "workflow.plan", payload: { template_ref: value } },
        1,
      );
      expect(event.data.template_ref).toMatchObject({ state: "excluded_by_policy" });
    }
  });

  // Issue #979 (S2, épico #976): `switch.case` é a 12ª role de um leaf
  // (`engine`/`flow-switch.ts`). Sem a entrada em SAFE_STRING_VALUES.role o
  // ledger redigia a role do leaf do `switch` como `excluded_by_policy`: o
  // oráculo positivo prende a entrada, e o negativo prende que a allow-list
  // continua FECHADA (vizinhos próximos não passam).
  it("preserves a leaf.started role 'switch.case' and its item_index", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "leaf.started", payload: { role: "switch.case", item_index: 2 } },
      1,
    );
    expect(event.data.role).toBe("switch.case");
    expect(event.data.item_index).toBe(2);
  });

  it("redacts a leaf.started role next to 'switch.case' that is not on the allow-list", () => {
    for (const role of ["switch.other", "Switch.case", "switch", "switch.case "]) {
      const event = publicAuditEvent("r", 1, { event_type: "leaf.started", payload: { role } }, 1);
      expect(event.data.role).toEqual({ state: "excluded_by_policy", characters: role.length });
    }
  });

  // Issue #981 (S4, épico #976): `escalated` é o 6º valor de `node.paused`'s
  // reason (checkpoint/quota_exhausted/token_budget_exhausted/user_requested/
  // route_fault). Sem a entrada em SAFE_STRING_VALUES.reason o ledger redigia a
  // pausa do `escalate` como `excluded_by_policy`: o oráculo positivo prende a
  // entrada, e o negativo prende que a allow-list continua FECHADA.
  it("preserves node.paused reason 'escalated' — never excluded_by_policy", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "node.paused", node_id: "review", payload: { reason: "escalated" } },
      1,
    );
    expect(event.event_type).toBe("node.paused");
    expect(event.data.reason).toBe("escalated");
  });

  it("redacts a node.paused reason next to 'escalated' that is not on the allow-list", () => {
    for (const reason of ["escalate", "Escalated", "escalated ", "escalation", "review"]) {
      const event = publicAuditEvent("r", 1, { event_type: "node.paused", payload: { reason } }, 1);
      expect(event.data.reason).toEqual({ state: "excluded_by_policy", characters: reason.length });
    }
  });

  it("redacts a leaf.failed partial outside the boolean vocabulary (a string, never coerced)", () => {
    const event = publicAuditEvent(
      "r",
      1,
      { event_type: "leaf.failed", payload: { status: "cancelled", partial: "true" } },
      1,
    );
    expect(event.data.partial).toEqual({ state: "excluded_by_policy", characters: 4 });
  });
});
