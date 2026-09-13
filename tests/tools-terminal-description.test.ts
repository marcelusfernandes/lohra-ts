// Issue #577 (épico #575): `terminal.ts:147-149` prometia que "Dangerous
// commands require user approval" -- nenhum modo do runtime implementa
// aprovação humana (ApprovalManager.require só libera com --yolo, uma
// sessão já aprovada, ou um callback que nunca é definido sob --json/
// --no-input; ver src/commands/chat.ts). O modelo lia a frase, entendia que
// um humano tinha recusado e retentava o mesmo comando ou uma variante.
// Este teste de contrato prende a nova description (padrão anti-drift) nas
// duas cópias que o catálogo mantém: `TERMINAL_SCHEMA` (terminal.ts) e a
// entrada `terminal` de `BUILTIN_DEFINITIONS` (builtin-definitions.ts, a
// lista que o runtime de fato envia ao modelo).
import { describe, expect, it } from "vitest";

import { TERMINAL_SCHEMA } from "../src/tools/terminal.js";
import { BUILTIN_DEFINITIONS } from "../src/tools/builtin-definitions.js";

function catalogTerminalDescription(): string {
  const entry = BUILTIN_DEFINITIONS.find((definition) => definition.function.name === "terminal");
  if (entry === undefined) throw new Error("terminal tool not found in BUILTIN_DEFINITIONS");
  return entry.function.description;
}

describe.each([
  ["TERMINAL_SCHEMA.description", TERMINAL_SCHEMA.description],
  ["BUILTIN_DEFINITIONS terminal description", catalogTerminalDescription()],
])("%s: dangerous-command refusal is automatic and final (#577)", (_label, description) => {
  it("no longer promises human approval", () => {
    expect(description).not.toContain("require user approval");
  });

  it("says the refusal is automatic", () => {
    expect(description).toContain("refused automatically");
  });

  it("says the refusal is final", () => {
    expect(description).toContain("final");
  });
});

describe("terminal description: the two catalog copies never drift apart (#577)", () => {
  it("TERMINAL_SCHEMA and BUILTIN_DEFINITIONS describe the dangerous-command policy identically", () => {
    expect(catalogTerminalDescription()).toBe(TERMINAL_SCHEMA.description);
  });
});
