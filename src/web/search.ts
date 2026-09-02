import { decodeHtmlEntities } from "./extract.js";
import { WebError } from "./safety.js";
import {
  FETCH_LIMITS,
  type ConnectorRequest,
  type ConnectorResponse,
  type Resolver,
  type SearchBackend,
  type SearchEnvelopeResult,
} from "./types.js";

export const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
export const DDG_MAX_BYTES = 2_000_000;
export const DEFAULT_SEARCH_RESULTS = 5;
export const MAX_SEARCH_RESULTS = 10;

export class SearchUnavailable extends WebError {
  constructor(message: string) {
    super(message);
    this.name = "SearchUnavailable";
  }
}

export function decodeDdgHref(href: string): string {
  if (href === "") return "";
  const question = href.indexOf("?");
  if (question === -1) return href.startsWith("http") ? href : "";
  const hash = href.indexOf("#", question);
  const query = href.slice(question + 1, hash === -1 ? undefined : hash);
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (pair.slice(0, equals) === "uddg") {
      const value = pair.slice(equals + 1);
      if (value === "") continue;
      try {
        return decodeURIComponent(value.replaceAll("+", "%20"));
      } catch {
        return value;
      }
    }
  }
  return href.startsWith("http") ? href : "";
}

interface PendingResult {
  title: string[];
  snippet: string[];
  url: string;
}

interface ParserState {
  results: SearchEnvelopeResult[];
  mode: "title" | "snippet" | null;
  pending: PendingResult;
}

function flushPending(state: ParserState): void {
  const title = state.pending.title.join(" ").trim();
  const url = state.pending.url;
  if (title !== "" && url !== "") {
    state.results.push({
      title,
      url,
      snippet: state.pending.snippet.join(" ").trim(),
    });
  }
  state.pending = { title: [], snippet: [], url: "" };
}

function classAttribute(tag: string): string {
  const match = /class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/.exec(tag);
  if (match === null) return "";
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/** Python HTMLParser semantics over the DDG results page: `result__a`
 * anchors start a result (committing the previous one) and `result__snippet`
 * anchors carry its snippet. Character refs are converted. */
export function parseDdgHtml(html: string, maxResults: number): SearchEnvelopeResult[] {
  const state: ParserState = {
    results: [],
    mode: null,
    pending: { title: [], snippet: [], url: "" },
  };
  let index = 0;
  const pushData = (raw: string): void => {
    const data = decodeHtmlEntities(raw).trim();
    if (data === "") return;
    if (state.mode === "title") state.pending.title.push(data);
    else if (state.mode === "snippet") state.pending.snippet.push(data);
  };
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      pushData(html.slice(index));
      break;
    }
    pushData(html.slice(index, open));
    const next = html[open + 1] ?? "";
    if (next === "!" || next === "?") {
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
      const close = html.indexOf(">", open);
      const name = tagNameOf(html, open + 2, close === -1 ? html.length : close);
      if (name === "a") state.mode = null;
      index = close === -1 ? html.length : close + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      pushData("<");
      index = open + 1;
      continue;
    }
    const close = findTagEnd(html, open);
    if (close === -1) {
      pushData(html.slice(open + 1));
      break;
    }
    const name = tagNameOf(html, open + 1, close);
    const selfClosing = (html[close - 1] ?? "") === "/";
    index = close + 1;
    if (name !== "a") continue;
    if (selfClosing) continue;
    const classes = classAttribute(html.slice(open + 1, close));
    if (classes.includes("result__a")) {
      flushPending(state);
      state.mode = "title";
      const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
        html.slice(open + 1, close),
      );
      const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "";
      state.pending.url = decodeDdgHref(href);
    } else if (classes.includes("result__snippet")) {
      state.mode = "snippet";
    }
  }
  flushPending(state);
  return state.results.slice(0, Math.max(0, maxResults));
}

function tagNameOf(source: string, start: number, end: number): string {
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

export interface DdgDeps {
  readonly connector: {
    request(request: ConnectorRequest): Promise<ConnectorResponse>;
  };
  readonly resolver: Resolver;
  readonly clock?: () => number;
  readonly parser?: (html: string, maxResults: number) => readonly SearchEnvelopeResult[];
}

interface CappedBody {
  readonly bytes: Uint8Array;
  readonly exceeded: boolean;
}

async function readBodyCapped(response: ConnectorResponse, maxBytes: number): Promise<CappedBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const result = await response.stream.next();
    if (result.done) break;
    const chunk = result.value;
    const space = maxBytes - total;
    if (chunk.length > space) {
      await response.stream.cancel();
      return { bytes: Buffer.concat(chunks), exceeded: true };
    }
    chunks.push(Buffer.from(chunk));
    total += chunk.length;
    if (total > maxBytes) {
      await response.stream.cancel();
      return { bytes: Buffer.concat(chunks), exceeded: true };
    }
  }
  return { bytes: Buffer.concat(chunks), exceeded: false };
}

export class DuckDuckGoBackend implements SearchBackend {
  readonly #connector: {
    request(request: ConnectorRequest): Promise<ConnectorResponse>;
  };
  readonly #clock: () => number;
  readonly #parser: (html: string, maxResults: number) => readonly SearchEnvelopeResult[];

  constructor(deps: DdgDeps) {
    this.#connector = deps.connector;
    this.#clock = deps.clock ?? (() => Date.now());
    this.#parser = deps.parser ?? parseDdgHtml;
  }

  async search(query: string, maxResults: number): Promise<readonly SearchEnvelopeResult[]> {
    const form = `q=${encodeURIComponent(query).replaceAll("%20", "+")}`;
    let response: ConnectorResponse;
    try {
      response = await this.#connector.request({
        url: DDG_ENDPOINT,
        method: "POST",
        headers: {
          "user-agent": FETCH_LIMITS.userAgent,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
        allowedAddresses: [],
        hostname: "html.duckduckgo.com",
        timeoutSeconds: FETCH_LIMITS.timeoutSeconds,
        deadlineMs: this.#clock() + FETCH_LIMITS.timeoutSeconds * 1000,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new SearchUnavailable(`search request failed: ${cause}`);
    }
    const read = await readBodyCapped(response, DDG_MAX_BYTES);
    if (response.status !== 200) {
      await response.stream.cancel();
      throw new SearchUnavailable(`search backend returned HTTP ${String(response.status)}`);
    }
    if (read.exceeded) {
      throw new SearchUnavailable("search response exceeded 2000000 bytes");
    }
    const html = Buffer.from(read.bytes).toString("utf8");
    return this.#parser(html, maxResults);
  }
}
