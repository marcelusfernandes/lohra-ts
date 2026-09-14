// Issue #605 (épico #575, follow-up dos vereditos r1/r2 da PR #598): esta
// suíte fixava `READ_FILE_SCHEMA`/`WRITE_FILE_SCHEMA` (`src/tools/
// filesystem.ts`) contra a description real de `BUILTIN_DEFINITIONS` — um
// teste anti-drift para dois exports que nenhum handler lê (nem
// `readFileTool` nem `writeFileTool` leem `.description`; `builtin-
// definitions.ts` é a única fonte que o runtime de fato envia ao modelo).
// Issue #641 (épico #637, grupo F, item 21) apaga os dois exports — o
// precedente que os mantinha vivos (o mesmo padrão em `TERMINAL_SCHEMA`,
// `tests/tools-terminal-description.test.ts`) cai junto. O que resta prender
// é só o catálogo (`BUILTIN_DEFINITIONS` continua a única fonte) e a
// ausência dos dois símbolos.
import { describe, expect, it } from "vitest";

import * as filesystem from "../src/tools/filesystem.js";
import { BUILTIN_DEFINITIONS } from "../src/tools/builtin-definitions.js";

function catalogDescription(name: string): string {
  const entry = BUILTIN_DEFINITIONS.find((definition) => definition.function.name === name);
  if (entry === undefined) throw new Error(`'${name}' tool not found in BUILTIN_DEFINITIONS`);
  return entry.function.description;
}

describe("read_file description lives only in BUILTIN_DEFINITIONS (#641)", () => {
  it("BUILTIN_DEFINITIONS carries a non-empty read_file description", () => {
    expect(catalogDescription("read_file").length).toBeGreaterThan(0);
  });

  it("no longer exports READ_FILE_SCHEMA — the catalog is the only source", () => {
    expect("READ_FILE_SCHEMA" in filesystem).toBe(false);
  });
});

describe("write_file description lives only in BUILTIN_DEFINITIONS (#641)", () => {
  it("BUILTIN_DEFINITIONS carries a non-empty write_file description", () => {
    expect(catalogDescription("write_file").length).toBeGreaterThan(0);
  });

  it("no longer exports WRITE_FILE_SCHEMA — the catalog is the only source", () => {
    expect("WRITE_FILE_SCHEMA" in filesystem).toBe(false);
  });
});
