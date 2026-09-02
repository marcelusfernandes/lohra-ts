import { describe, expect, it } from "vitest";

import {
  MAX_HTML_TEXT_CHARS,
  decodeHtmlEntities,
  htmlToText,
} from "../src/web/index.js";

describe("decodeHtmlEntities", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeHtmlEntities("Hello &amp; welcome")).toBe("Hello & welcome");
    expect(decodeHtmlEntities("&lt;tag&gt; &quot;q&quot; &apos;a&apos;")).toBe(
      '<tag> "q" \'a\'',
    );
    expect(decodeHtmlEntities("&#72;&#73; &#x48;&#x49;")).toBe("HI HI");
    expect(decodeHtmlEntities("caf&eacute; &copy; &hellip;")).toBe("café © …");
  });

  it("leaves malformed references literal", () => {
    expect(decodeHtmlEntities("a & b &unknownx; c")).toBe("a & b &unknownx; c");
    expect(decodeHtmlEntities("a &amp b")).toBe("a & b");
  });
});

describe("htmlToText", () => {
  it("reproduces the oracle W5 fixture exactly", () => {
    const html =
      "<head>no</head><nav>no</nav><h1>Hello &amp; welcome</h1><script>no</script><p> spaced\n words </p><em>tail</em><b>bold</b>";
    expect(htmlToText(html)).toBe("Hello & welcome spaced words tail bold");
  });

  it("drops every skip-tag family without leaking nested content", () => {
    const html =
      "<head><title>t</title><style>.x{}</style></head><noscript>n</noscript><template>tpl</template><svg>circle</svg><footer>f</footer><main>kept</main>";
    expect(htmlToText(html)).toBe("kept");
  });

  it("keeps tags outside the skip set and decodes entities inside them", () => {
    expect(htmlToText("<div>a &lt; b</div><span>c</span>")).toBe("a < b c");
  });

  it("tolerates malformed html without loops", () => {
    expect(htmlToText("<div>unclosed <b>bold")).toBe("unclosed bold");
    expect(htmlToText("a < b")).toBe("a < b");
    expect(htmlToText("<a href='x>y'>link</a>")).toBe("link");
    expect(htmlToText("<!-- comment -->after")).toBe("after");
    expect(htmlToText("<!DOCTYPE html><html><body>x</body></html>")).toBe("x");
    expect(htmlToText("")).toBe("");
    expect(htmlToText("<<<>>>")).toBe("< < < >>>");
  });

  it("collapses all whitespace variants", () => {
    expect(htmlToText("<p>a</p>\t<p>b</p>\n<p>c</p>")).toBe("a b c");
  });

  it("caps at 20000 characters on the 19999/20000/20001 boundary", () => {
    for (const length of [MAX_HTML_TEXT_CHARS - 1, MAX_HTML_TEXT_CHARS, MAX_HTML_TEXT_CHARS + 1]) {
      const text = "x".repeat(length);
      const html = `<p>${text}</p>`;
      const output = htmlToText(html);
      expect(Array.from(output).length).toBe(Math.min(length, MAX_HTML_TEXT_CHARS));
    }
  });

  it("caps multibyte characters by code point, not utf16 units", () => {
    const html = `<p>${"😀".repeat(MAX_HTML_TEXT_CHARS)}</p>`;
    const output = htmlToText(html);
    expect(Array.from(output).length).toBe(MAX_HTML_TEXT_CHARS);
  });
});
