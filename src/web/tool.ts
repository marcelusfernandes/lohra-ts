import { hasJsonValue } from "../serialization/json-presence.js";
import { toolError, toolResult } from "../tools/envelope.js";
import { htmlToText } from "./extract.js";
import { fetchUrl } from "./fetch.js";
import { createPinnedConnector, createPlainConnector, nodeResolver } from "./connector.js";
import {
  DEFAULT_SEARCH_RESULTS,
  DuckDuckGoBackend,
  MAX_SEARCH_RESULTS,
  SearchUnavailable,
} from "./search.js";
import { WebError, WebTransportError } from "./safety.js";
import type { SearchBackend, WebTransport } from "./types.js";

export type { SearchBackend, WebTransport };

let webTransport: WebTransport = {
  resolver: nodeResolver,
  connector: createPinnedConnector(),
};

let searchBackend: SearchBackend = new DuckDuckGoBackend({
  resolver: webTransport.resolver,
  connector: createPlainConnector(),
});

export function setWebTransport(transport: WebTransport): void {
  webTransport = transport;
}

export function currentWebTransport(): WebTransport {
  return webTransport;
}

export function setSearchBackend(backend: SearchBackend): void {
  searchBackend = backend;
}

export function currentSearchBackend(): SearchBackend {
  return searchBackend;
}

/** Coercion to an integer for this tool's `max_results` argument: booleans,
 * ints and digit strings convert; floats truncate; anything else is not a
 * valid integer (mapped to the default). */
function coerceInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (!Number.isInteger(value)) return Math.trunc(value);
    return value;
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[+-]?[0-9]+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
    return null;
  }
  return null;
}

export function coerceMaxResults(value: unknown): number {
  const parsed = coerceInt(value);
  if (parsed === null) return DEFAULT_SEARCH_RESULTS;
  return Math.max(1, Math.min(parsed, MAX_SEARCH_RESULTS));
}

export function isMissingQuery(query: unknown): boolean {
  if (!hasJsonValue(query)) return true;
  if (typeof query === "string") return query.trim() === "";
  return JSON.stringify(query).trim() === "";
}

export async function webFetchHandler(args: Readonly<Record<string, unknown>>): Promise<string> {
  const url = args["url"];
  if (!url || typeof url !== "string") {
    return toolError("missing required argument 'url' (string)");
  }
  try {
    const outcome = await fetchUrl(url, webTransport);
    return toolResult(undefined, { url, text: htmlToText(outcome.text) });
  } catch (error) {
    if (error instanceof WebError) return toolError(error.message, { url });
    if (error instanceof WebTransportError) {
      return toolError(`could not fetch the page: ${error.message}`, { url });
    }
    throw error;
  }
}

export async function webSearchHandler(args: Readonly<Record<string, unknown>>): Promise<string> {
  const query = args["query"];
  if (isMissingQuery(query)) {
    return toolError("missing required argument 'query' (string)");
  }
  const maxResults = coerceMaxResults(args["max_results"]);
  const backendQuery = typeof query === "string" ? query : JSON.stringify(query);
  try {
    const results = await searchBackend.search(backendQuery, maxResults);
    return toolResult(undefined, {
      query,
      results: results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
      })),
    });
  } catch (error) {
    if (error instanceof SearchUnavailable) {
      return toolError(`search is unavailable right now: ${error.message}`, { query });
    }
    if (error instanceof WebError) {
      return toolError(`search failed: ${error.message}`, { query });
    }
    throw error;
  }
}
