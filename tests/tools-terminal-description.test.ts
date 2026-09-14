// Issue #577 (épico #575): `terminal.ts:147-149` prometia que "Dangerous
// commands require user approval" -- nenhum modo do runtime implementa
// aprovação humana (ApprovalManager.require só libera com --yolo, uma
// sessão já aprovada, ou um callback que nunca é definido sob --json/
// --no-input; ver src/commands/chat.ts). O modelo lia a frase, entendia que
// um humano tinha recusado e retentava o mesmo comando ou uma variante.
// Issue #641 (épico #637, grupo F, item 21) apaga `TERMINAL_SCHEMA`
// (`src/tools/terminal.ts`) — era um export morto mantido só para este
// teste anti-drift comparar contra a entrada `terminal` de
// `BUILTIN_DEFINITIONS`, a única lista que o runtime de fato envia ao
// modelo. O que resta prender é o texto do catálogo em si e a ausência do
// símbolo.
import { describe, expect, it } from "vitest";

import * as terminal from "../src/tools/terminal.js";
import { BUILTIN_DEFINITIONS } from "../src/tools/builtin-definitions.js";

function catalogTerminalDescription(): string {
  const entry = BUILTIN_DEFINITIONS.find((definition) => definition.function.name === "terminal");
  if (entry === undefined) throw new Error("terminal tool not found in BUILTIN_DEFINITIONS");
  return entry.function.description;
}

describe("BUILTIN_DEFINITIONS terminal description: dangerous-command refusal is automatic and final (#577)", () => {
  const description = catalogTerminalDescription();

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

describe("terminal.ts no longer exports the dead TERMINAL_SCHEMA copy (#641)", () => {
  it("BUILTIN_DEFINITIONS is the only source of the terminal description", () => {
    expect("TERMINAL_SCHEMA" in terminal).toBe(false);
  });
});
