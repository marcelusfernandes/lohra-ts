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

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  iexcl: "¡",
  cent: "¢",
  pound: "£",
  curren: "¤",
  yen: "¥",
  brvbar: "¦",
  sect: "§",
  uml: "¨",
  copy: "©",
  ordf: "ª",
  laquo: "«",
  not: "¬",
  shy: "­",
  reg: "®",
  macr: "¯",
  deg: "°",
  plusmn: "±",
  sup2: "²",
  sup3: "³",
  acute: "´",
  micro: "µ",
  para: "¶",
  middot: "·",
  cedil: "¸",
  sup1: "¹",
  ordm: "º",
  raquo: "»",
  frac14: "¼",
  frac12: "½",
  frac34: "¾",
  iquest: "¿",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  ETH: "Ð",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  times: "×",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
  Yacute: "Ý",
  THORN: "Þ",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  eth: "ð",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  divide: "÷",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  thorn: "þ",
  yuml: "ÿ",
  OElig: "Œ",
  oelig: "œ",
  Scaron: "Š",
  scaron: "š",
  Yuml: "Ÿ",
  fnof: "ƒ",
  circ: "ˆ",
  tilde: "˜",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "‌",
  zwj: "‍",
  lrm: "‎",
  rlm: "‏",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  dagger: "†",
  Dagger: "‡",
  bull: "•",
  hellip: "…",
  permil: "‰",
  prime: "′",
  Prime: "″",
  lsaquo: "‹",
  rsaquo: "›",
  oline: "‾",
  frasl: "⁄",
  euro: "€",
  trade: "™",
  forall: "∀",
  part: "∂",
  exist: "∃",
  empty: "∅",
  nabla: "∇",
  isin: "∈",
  notin: "∉",
  ni: "∋",
  prod: "∏",
  sum: "∑",
  minus: "−",
  lowast: "∗",
  radic: "√",
  prop: "∝",
  infin: "∞",
  ang: "∠",
  and: "∧",
  or: "∨",
  cap: "∩",
  cup: "∪",
  int: "∫",
  there4: "∴",
  sim: "∼",
  cong: "≅",
  asymp: "≈",
  ne: "≠",
  equiv: "≡",
  le: "≤",
  ge: "≥",
  sub: "⊂",
  sup: "⊃",
  nsub: "⊄",
  sube: "⊆",
  supe: "⊇",
  oplus: "⊕",
  otimes: "⊗",
  perp: "⊥",
  sdot: "⋅",
  lceil: "⌈",
  rceil: "⌉",
  lfloor: "⌊",
  rfloor: "⌋",
  lang: "〈",
  rang: "〉",
  loz: "◊",
  spades: "♠",
  clubs: "♣",
  hearts: "♥",
  diams: "♦",
};

/** Python `html.unescape` over the subset of fixtures the parity matrix pins:
 * numeric decimal/hex references (with or without a trailing `;`) and the
 * named table (legacy amp/lt/gt/quot also match without the semicolon). */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  let result = "";
  let index = 0;
  while (index < text.length) {
    const ampersand = text.indexOf("&", index);
    if (ampersand === -1) {
      result += text.slice(index);
      break;
    }
    result += text.slice(index, ampersand);
    const decoded = decodeAt(text, ampersand + 1);
    if (decoded === null) {
      result += "&";
      index = ampersand + 1;
    } else {
      result += decoded.text;
      index = ampersand + 1 + decoded.consumed;
    }
  }
  return result;
}

function decodeOne(name: string, consumed: number): { text: string; consumed: number } | null {
  const named = NAMED_ENTITIES[name];
  if (named === undefined) return null;
  return { text: named, consumed };
}

function decodeNumeric(
  body: string,
  radix: 10 | 16,
  terminated: boolean,
  prefixLength: number,
): { text: string; consumed: number } | null {
  if (body.length === 0) return null;
  const code = Number.parseInt(body, radix);
  if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff) {
    return terminated
      ? { text: "\ufffd", consumed: prefixLength + body.length + 1 }
      : null;
  }
  return {
    text: String.fromCodePoint(code),
    consumed: prefixLength + body.length + (terminated ? 1 : 0),
  };
}

function decodeAt(text: string, start: number): { text: string; consumed: number } | null {
  const rest = text.slice(start);
  const hex = /^#[xX]([0-9a-fA-F]+)/.exec(rest);
  if (hex !== null) {
    const body = hex[1] ?? "";
    const terminated = rest[2 + body.length] === ";";
    return decodeNumeric(body, 16, terminated, 2);
  }
  const decimal = /^#([0-9]+)/.exec(rest);
  if (decimal !== null) {
    const body = decimal[1] ?? "";
    const terminated = rest[1 + body.length] === ";";
    return decodeNumeric(body, 10, terminated, 1);
  }
  const named = /^([a-zA-Z][a-zA-Z0-9]*);/.exec(rest);
  if (named !== null) {
    const decoded = decodeOne(named[1] ?? "", (named[1]?.length ?? 0) + 1);
    return decoded === null ? null : { text: decoded.text, consumed: decoded.consumed };
  }
  const legacy = /^([a-zA-Z][a-zA-Z0-9]*)(?![a-zA-Z0-9])/.exec(rest);
  if (legacy !== null) return decodeOne(legacy[1] ?? "", legacy[1]?.length ?? 0);
  return null;
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
