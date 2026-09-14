// Issue #605 (épico #575, follow-up dos vereditos r1/r2 da PR #598):
// `READ_FILE_SCHEMA`/`WRITE_FILE_SCHEMA` (`src/tools/filesystem.ts`)
// mantinham o texto anterior à dieta do catálogo (#585) e divergiam da
// entrada `read_file`/`write_file` que `BUILTIN_DEFINITIONS` de fato envia
// ao modelo — exports mortos (nenhum handler os lê; só a schema estática
// importa) com uma cópia desatualizada. Mesmo padrão anti-drift que
// `tests/tools-terminal-description.test.ts` já fixou para `TERMINAL_SCHEMA`:
// mantém as duas cópias (não apaga o export), mas prende que o texto é
// idêntico ao que o catálogo realmente envia.
import { describe, expect, it } from "vitest";

import { READ_FILE_SCHEMA, WRITE_FILE_SCHEMA } from "../src/tools/filesystem.js";
import { BUILTIN_DEFINITIONS } from "../src/tools/builtin-definitions.js";

function catalogDescription(name: string): string {
  const entry = BUILTIN_DEFINITIONS.find((definition) => definition.function.name === name);
  if (entry === undefined) throw new Error(`'${name}' tool not found in BUILTIN_DEFINITIONS`);
  return entry.function.description;
}

describe("read_file description: the two catalog copies never drift apart (#605)", () => {
  it("READ_FILE_SCHEMA and BUILTIN_DEFINITIONS describe read_file identically", () => {
    expect(READ_FILE_SCHEMA.description).toBe(catalogDescription("read_file"));
  });
});

describe("write_file description: the two catalog copies never drift apart (#605)", () => {
  it("WRITE_FILE_SCHEMA and BUILTIN_DEFINITIONS describe write_file identically", () => {
    expect(WRITE_FILE_SCHEMA.description).toBe(catalogDescription("write_file"));
  });
});
