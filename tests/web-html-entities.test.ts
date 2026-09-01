import { describe, expect, it } from "vitest";

import { decodeHtmlEntities, htmlToText } from "../src/web/index.js";

/* The matrix below is pinned from the oracle's html.unescape
 * (Python 3.12.10): scripts/parity/web-tools/html-matrix-oracle.py */
const MATRIX: readonly (readonly [string, string])[] = [
  ["A &NotEqualTilde; B", "A \u2242\u0338 B"],
  ["A &#128; B", "A \u20ac B"],
  ["A &#x80; B", "A \u20ac B"],
  ["A &#0; B", "A \ufffd B"],
  ["A &#x0; B", "A \ufffd B"],
  ["A &#x7f; B", "A  B"],
  ["A &#x81; B", "A \u0081 B"],
  ["A &#55296; B", "A \ufffd B"],
  ["A &#1114112; B", "A \ufffd B"],
  ["A &#xfffe; B", "A  B"],
  ["A &amp B", "A & B"],
  ["A &ampx B", "A &x B"],
  ["A &notit; B", "A \u00acit; B"],
  ["A &notin; B", "A \u2209 B"],
  ["A &amp; B", "A & B"],
  ["A &lt;tag&gt; B", "A <tag> B"],
  ["A &Nope; B", "A &Nope; B"],
  ["A & &amp &AMP B", "A & & & B"],
  ["A &#x1F600; B", "A \u{1F600} B"],
  ["A &CounterClockwiseContourIntegral; B", "A \u2233 B"],
  ["A &not; B", "A \u00ac B"],
  ["A &not a B", "A \u00ac a B"],
  ["A &ctdot; B", "A \u22ef B"],
  ["A &acE; B", "A \u223e\u0333 B"],
  ["A &bnequiv; B", "A \u2261\u20e5 B"],
];

describe("html.unescape parity with the pinned oracle", () => {
  it.each(MATRIX)("decodes %j exactly", (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  it("decodes multi-code-point entities inside the text extraction", () => {
    expect(htmlToText("<p>A &NotEqualTilde; B</p>")).toBe("A \u2242\u0338 B");
    expect(htmlToText("<p>A &#128; B</p>")).toBe("A \u20ac B");
  });
});
