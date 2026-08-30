import { describe, expect, it } from "vitest";

import { pythonRepr } from "../src/serialization/python-repr.js";

describe("pythonRepr", () => {
  it("wraps a plain string in single quotes by default", () => {
    expect(pythonRepr("abc")).toBe("'abc'");
  });

  it("leaves non-ASCII printable characters literal, not escaped", () => {
    expect(pythonRepr("çã")).toBe("'çã'");
  });

  it("leaves a double quote literal when there is no single quote to conflict with", () => {
    expect(pythonRepr('a"b')).toBe("'a\"b'");
  });

  // Evaluator baseline §9/L27 (evidence-s13-repr-edges.json): repr() switches
  // to double quotes when the string contains a single quote but no double
  // quote — the errata E1 template's naive '${raw}' interpolation gets this
  // wrong for exactly this case.
  it("switches to double quotes when the string contains a single quote and no double quote", () => {
    expect(pythonRepr("a'b")).toBe('"a\'b"');
  });

  it("doubles a literal backslash", () => {
    expect(pythonRepr("a\\b")).toBe("'a\\\\b'");
  });

  it("escapes a newline as a two-character \\n, keeping the repr on one line", () => {
    expect(pythonRepr("a\nb")).toBe("'a\\nb'");
  });

  it("escapes carriage return and tab the same way", () => {
    expect(pythonRepr("a\rb")).toBe("'a\\rb'");
    expect(pythonRepr("a\tb")).toBe("'a\\tb'");
  });

  it("escapes other C0 control characters as \\xHH", () => {
    expect(pythonRepr("a\x01b")).toBe("'a\\x01b'");
  });

  it("escapes the chosen quote character when both quote types are present", () => {
    // Both ' and " present: repr() keeps the default single quote and
    // escapes only the single quotes.
    expect(pythonRepr("a'b\"c")).toBe("'a\\'b\"c'");
  });
});
