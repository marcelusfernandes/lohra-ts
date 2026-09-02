import { spawnSync } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { pythonRepr } from "../src/serialization/python-repr.js";

function pythonStr(source: string): string {
  const result = spawnSync(process.env.PYTHON ?? "python3", ["-c", source], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || "python str() probe failed");
  return result.stdout.replace(/\n$/u, "");
}

describe("pythonRepr", () => {
  it("renders None/True/False for null/undefined/booleans", () => {
    expect(pythonRepr(null)).toBe("None");
    expect(pythonRepr(undefined)).toBe("None");
    expect(pythonRepr(true)).toBe("True");
    expect(pythonRepr(false)).toBe("False");
  });

  it("quotes strings with single quotes by default", () => {
    expect(pythonRepr("hello")).toBe("'hello'");
    expect(pythonRepr("it's")).toBe('"it\'s"');
    expect(pythonRepr(`say "hi"`)).toBe(`'say "hi"'`);
    expect(pythonRepr(`both ' and "`)).toBe(`'both \\' and "'`);
  });

  it("renders numbers via String()", () => {
    expect(pythonRepr(5)).toBe("5");
    expect(pythonRepr(-3.5)).toBe("-3.5");
  });

  it("renders arrays and objects recursively with Python separators", () => {
    expect(pythonRepr([1, "a", null])).toBe("[1, 'a', None]");
    expect(pythonRepr({ type: "text", text: "hi" })).toBe("{'type': 'text', 'text': 'hi'}");
  });

  it("matches the contract's measured B5 vector: 47-byte repr of a text part", () => {
    const content = [{ type: "text", text: "SCEN:nousage abcd" }];
    const rendered = pythonRepr(content);
    expect(rendered).toBe("[{'type': 'text', 'text': 'SCEN:nousage abcd'}]");
    expect(rendered.length).toBe(47);
  });

  it("cross-checks against real Python str() for nested content", () => {
    const content = [{ type: "text", text: "SCEN:nousage abcd" }];
    const expected = pythonStr(`print(str(${JSON.stringify(content)}))`);
    expect(pythonRepr(content)).toBe(expected);
  });

  it("cross-checks a dict-of-dicts against real Python str()", () => {
    const value = { error: { message: "upstream refused", type: "teapot_error", code: 418 } };
    const expected = pythonStr(`print(str(${JSON.stringify(value)}))`);
    expect(pythonRepr(value)).toBe(expected);
  });

  it("preserves T13's repr edges for printable Unicode, slashes and controls", () => {
    expect(pythonRepr("çã")).toBe("'çã'");
    expect(pythonRepr("a\\b")).toBe("'a\\\\b'");
    expect(pythonRepr("a\nb\rc\td\x01e")).toBe("'a\\nb\\rc\\td\\x01e'");
  });
});
