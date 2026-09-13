// Issue #583 (épico #575, P7): a sentinela lida do turno final do
// subagente — última linha não-vazia, casada contra `result:`/`failed:`/
// `needs input:` (case-insensitive, o modelo escreve como quiser
// capitalizar). Nenhum caso aqui lança: ausência de sentinela é `null`,
// nunca erro (decisão 3 da issue — `failed:` não é o mesmo que o turno ter
// falhado de verdade).
import { describe, expect, it } from "vitest";

import { parseOutcomeSentinel } from "../src/orchestration/outcome-sentinel.js";

describe("parseOutcomeSentinel", () => {
  it("reads a trailing result: line", () => {
    expect(parseOutcomeSentinel("did the thing.\n\nresult: all done")).toBe("result");
  });

  it("reads a trailing failed: line", () => {
    expect(parseOutcomeSentinel("tried the thing.\n\nfailed: permission denied")).toBe("failed");
  });

  it("reads a trailing needs input: line", () => {
    expect(parseOutcomeSentinel("partway there.\n\nneeds input: which branch?")).toBe(
      "needs_input",
    );
  });

  it("is case-insensitive on the sentinel keyword", () => {
    expect(parseOutcomeSentinel("Result: Done.")).toBe("result");
    expect(parseOutcomeSentinel("FAILED: nope")).toBe("failed");
    expect(parseOutcomeSentinel("Needs Input: what path?")).toBe("needs_input");
  });

  it("ignores trailing blank lines and whitespace when finding the last line", () => {
    expect(parseOutcomeSentinel("result: done\n\n   \n")).toBe("result");
  });

  it("returns null when the last non-blank line is not a sentinel", () => {
    expect(parseOutcomeSentinel("just a plain summary, no sentinel")).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(parseOutcomeSentinel("")).toBeNull();
    expect(parseOutcomeSentinel("   \n  \n")).toBeNull();
  });

  it("never matches 'results:' (plural) as the result: sentinel", () => {
    expect(parseOutcomeSentinel("results: not a real sentinel")).toBeNull();
  });

  it("only looks at the LAST non-blank line, not any earlier one", () => {
    expect(
      parseOutcomeSentinel("result: this is not the last line\njust prose after it"),
    ).toBeNull();
  });
});
