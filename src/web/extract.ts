import { HTML5_ENTITIES } from "./html5-entities.js";

const SKIP_TAGS = new Set([
  "script",
  "style",
  "head",
  "noscript",
  "template",
  "nav",
  "footer",
  "svg",
]);

const RAW_TEXT_TAGS = new Set(["script", "style"]);

export const MAX_HTML_TEXT_CHARS = 20_000;

/* CPython 3.12.10 html/__init__.py: numeric-reference remapping (verbatim). */
const INVALID_CHARREFS: Readonly<Record<number, string>> = {
  "0": "\ufffd",
  "13": "\r",
  "128": "\u20ac",
  "129": "\u0081",
  "130": "\u201a",
  "131": "\u0192",
  "132": "\u201e",
  "133": "\u2026",
  "134": "\u2020",
  "135": "\u2021",
  "136": "\u02c6",
  "137": "\u2030",
  "138": "\u0160",
  "139": "\u2039",
  "140": "\u0152",
  "141": "\u008d",
  "142": "\u017d",
  "143": "\u008f",
  "144": "\u0090",
  "145": "\u2018",
  "146": "\u2019",
  "147": "\u201c",
  "148": "\u201d",
  "149": "\u2022",
  "150": "\u2013",
  "151": "\u2014",
  "152": "\u02dc",
  "153": "\u2122",
  "154": "\u0161",
  "155": "\u203a",
  "156": "\u0153",
  "157": "\u009d",
  "158": "\u017e",
  "159": "\u0178",
};

const INVALID_CODEPOINTS: ReadonlySet<number> = new Set<number>([
  ...range(0x1, 0x8),
  ...range(0xe, 0x1f),
  ...range(0x7f, 0x9f),
  ...range(0xfdd0, 0xfdef),
  0xb,
  0xfffe, 0xffff, 0x1fffe, 0x1ffff, 0x2fffe, 0x2ffff, 0x3fffe, 0x3ffff,
  0x4fffe, 0x4ffff, 0x5fffe, 0x5ffff, 0x6fffe, 0x6ffff, 0x7fffe, 0x7ffff,
  0x8fffe, 0x8ffff, 0x9fffe, 0x9ffff, 0xafffe, 0xaffff, 0xbfffe, 0xbffff,
  0xcfffe, 0xcffff, 0xdfffe, 0xdffff, 0xefffe, 0xeffff, 0xffffe, 0xfffff,
  0x10fffe, 0x10ffff,
]);

function range(fromInclusive: number, toInclusive: number): number[] {
  const values: number[] = [];
  for (let value = fromInclusive; value <= toInclusive; value += 1) values.push(value);
  return values;
}

const HTML5_TABLE: ReadonlyMap<string, string> = new Map(
  HTML5_ENTITIES.map((entry) => [entry.name, entry.value]),
);

/* CPython 3.12.10 html.unescape semantics, verbatim:
 * r'&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)' */
const CHARREF_PATTERN = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

function replaceCharref(group: string): string {
  if (group.startsWith("#")) {
    let num: number;
    if (group[1] === "x" || group[1] === "X") {
      num = Number.parseInt(group.slice(2).replace(/;+$/, ""), 16);
    } else {
      num = Number.parseInt(group.slice(1).replace(/;+$/, ""), 10);
    }
    const remapped = INVALID_CHARREFS[num];
    if (remapped !== undefined) return remapped;
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "\ufffd";
    if (INVALID_CODEPOINTS.has(num)) return "";
    return String.fromCodePoint(num);
  }
  const exact = HTML5_TABLE.get(group);
  if (exact !== undefined) return exact;
  for (let x = group.length - 1; x >= 2; x -= 1) {
    const prefix = HTML5_TABLE.get(group.slice(0, x));
    if (prefix !== undefined) return prefix + group.slice(x);
  }
  return `&${group}`;
}

/** Python `html.unescape` (CPython 3.12.10), byte-for-byte semantics. */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF_PATTERN, (_match, group: string) => replaceCharref(group));
}

function tagName(source: string, start: number, end: number): string {
  let name = "";
  for (let index = start; index < end; index += 1) {
    const character = source[index] ?? "";
    if (/\s/.test(character) || character === "/" || character === ">") break;
    name += character;
  }
  return name.toLowerCase();
}

function findTagEnd(html: string, start: number): number {
  let quoted: string | null = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index] ?? "";
    if (quoted !== null) {
      if (character === quoted) quoted = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quoted = character;
      continue;
    }
    if (character === ">") return index;
  }
  return -1;
}

function findRawClose(html: string, from: number, tag: string): number {
  const search = html.toLowerCase();
  let position = from;
  for (;;) {
    const open = search.indexOf(`</`, position);
    if (open === -1) return -1;
    const candidate = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(search.slice(open));
    if (candidate === null) {
      position = open + 2;
      continue;
    }
    const name = (candidate[1] ?? "").toLowerCase();
    if (name === tag) return open + candidate[0].length;
    position = open + 2;
  }
}

export function htmlToText(html: string, maxChars: number = MAX_HTML_TEXT_CHARS): string {
  const parts: string[] = [];
  let skipDepth = 0;
  let textRun = "";
  const flush = (): void => {
    if (textRun === "") return;
    if (skipDepth === 0) {
      const stripped = decodeHtmlEntities(textRun).trim();
      if (stripped !== "") parts.push(stripped);
    }
    textRun = "";
  };
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      textRun += html.slice(index);
      break;
    }
    textRun += html.slice(index, open);
    const next = html[open + 1] ?? "";
    if (next === "!" || next === "?") {
      flush();
      if (html.startsWith("<!--", open)) {
        const close = html.indexOf("-->", open + 4);
        index = close === -1 ? html.length : close + 3;
      } else {
        const close = html.indexOf(">", open);
        index = close === -1 ? html.length : close + 1;
      }
      continue;
    }
    if (next === "/") {
      flush();
      const close = findTagEnd(html, open + 1);
      const name = tagName(html, open + 2, close === -1 ? html.length : close);
      if (SKIP_TAGS.has(name) && skipDepth > 0) skipDepth -= 1;
      index = close === -1 ? html.length : close + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      flush();
      if (skipDepth === 0) parts.push("<");
      index = open + 1;
      continue;
    }
    const close = findTagEnd(html, open);
    if (close === -1) {
      flush();
      break;
    }
    const name = tagName(html, open + 1, close);
    const selfClosing = (html[close - 1] ?? "") === "/";
    flush();
    index = close + 1;
    if (SKIP_TAGS.has(name)) {
      skipDepth += 1;
      if (RAW_TEXT_TAGS.has(name) && !selfClosing) {
        const rawClose = findRawClose(html, index, name);
        if (rawClose === -1) break;
        index = rawClose;
        skipDepth -= 1;
      } else if (selfClosing) {
        skipDepth -= 1;
      }
    }
  }
  flush();
  const joined = parts.join(" ");
  const collapsed = joined.replace(/\s+/gu, " ").trim();
  return Array.from(collapsed)
    .slice(0, maxChars)
    .join("");
}
