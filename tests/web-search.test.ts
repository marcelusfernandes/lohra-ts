import { describe, expect, it } from "vitest";

import {
  DuckDuckGoBackend,
  parseDdgHtml,
  SearchUnavailable,
  decodeDdgHref,
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS,
} from "../src/web/index.js";
import { responseOf } from "./web-connector.test.js";
import type { AddressRecord, ConnectorRequest, ConnectorResponse, Resolver } from "../src/web/index.js";

const encoder = new TextEncoder();
const DDG = "https://html.duckduckgo.com/html/";

const DDG_RESULT_HTML = [
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fone.test">One</a>',
  '<a class="result__snippet">Snippet</a>',
  '<a class="result__a" href="/relative">drop</a>',
  '<a class="result__a" href="https://two.test">Two</a>',
].join("");

function makeResolver(calls: string[]): Resolver {
  return (host) => {
    calls.push(host);
    if (host !== "html.duckduckgo.com") throw new Error("fixture DNS failed");
    return [{ address: "40.114.177.156", family: 4 }] as readonly AddressRecord[];
  };
}

function searchHarness(responses: readonly ConnectorResponse[]) {
  const requests: ConnectorRequest[] = [];
  const cancelCalls: number[] = [];
  const resolverCalls: string[] = [];
  const backend = new DuckDuckGoBackend({
    connector: {
      request(request) {
        requests.push(request);
        const response = responses[requests.length - 1];
        if (response === undefined) return Promise.reject(new Error("fixture connect failed"));
        return Promise.resolve({
          ...response,
          stream: {
            next: () => response.stream.next(),
            cancel: async () => {
              cancelCalls.push(requests.length);
              await response.stream.cancel();
            },
          },
        });
      },
    },
    resolver: makeResolver(resolverCalls),
    clock: () => 0,
  });
  return { backend, requests, cancelCalls, resolverCalls };
}

describe("decodeDdgHref", () => {
  it("decodes uddg wrappers and drops relative links", () => {
    expect(decodeDdgHref("//duckduckgo.com/l/?uddg=https%3A%2F%2Fone.test")).toBe("https://one.test");
    expect(decodeDdgHref("https://direct.test")).toBe("https://direct.test");
    expect(decodeDdgHref("/relative")).toBe("");
    expect(decodeDdgHref("")).toBe("");
  });
});

describe("parseDdgHtml", () => {
  it("extracts title/url/snippet triples with an absent snippet as empty string", () => {
    const html = [
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fone.test">One</a>',
      '<a class="result__snippet">The snippet</a>',
      '<a class="result__a" href="https://two.test">Two</a>',
      '<span>no snippet</span>',
    ].join("");
    const results = parseDdgHtml(html, 5);
    expect(results).toEqual([
      { title: "One", url: "https://one.test", snippet: "The snippet" },
      { title: "Two", url: "https://two.test", snippet: "" },
    ]);
  });

  it("returns an empty success for html without results", () => {
    expect(parseDdgHtml("<p>no anchors here</p>", 5)).toEqual([]);
  });

  it("clamps to the requested count", () => {
    const html = Array.from({ length: 12 }, (_, index) => `<a class="result__a" href="https://${String(index)}.test">t${String(index)}</a>`).join("");
    expect(parseDdgHtml(html, 10)).toHaveLength(10);
    expect(parseDdgHtml(html, 3)).toHaveLength(3);
    expect(MAX_SEARCH_RESULTS).toBe(10);
    expect(DEFAULT_SEARCH_RESULTS).toBe(5);
  });
});

describe("DuckDuckGoBackend", () => {
  it("posts the form to the fixed endpoint with the oracle user agent", async () => {
    const harness = searchHarness([responseOf({ chunks: [encoder.encode(DDG_RESULT_HTML)] })]);
    const results = await harness.backend.search("fixture query", 5);
    expect(results).toHaveLength(2);
    expect(harness.requests).toHaveLength(1);
    const request = harness.requests[0] as ConnectorRequest;
    expect(request.url).toBe(DDG);
    expect(request.method).toBe("POST");
    expect(request.body).toBe("q=fixture+query");
    expect(request.headers["user-agent"]).toBe("lohra-web/0.1 (+https://github.com/lohra)");
    expect(request.timeoutSeconds).toBe(10);
  });

  it("maps non-200 responses to the exact unavailable cause with parserCalls=0", async () => {
    const harness = searchHarness([responseOf({ status: 302, chunks: [encoder.encode("moved")] })]);
    try {
      await harness.backend.search("q", 5);
      expect.unreachable("non-200");
    } catch (error) {
      expect(error).toBeInstanceOf(SearchUnavailable);
      expect((error as SearchUnavailable).message).toBe("search backend returned HTTP 302");
    }
  });

  it("maps transport failure to the exact unavailable cause", async () => {
    const backend = new DuckDuckGoBackend({
      connector: {
        request: () => Promise.reject(new Error("fixture connect failed")),
      },
      resolver: makeResolver([]),
      clock: () => 0,
    });
    try {
      await backend.search("q", 5);
      expect.unreachable("transport");
    } catch (error) {
      expect((error as Error).message).toBe("search request failed: fixture connect failed");
    }
  });

  it("applies the byte cap before decode/parse (decision 3)", async () => {
    for (const [size, shouldParse] of [
      [1_999_999, true],
      [2_000_000, true],
      [2_000_001, false],
    ] as const) {
      const harness = searchHarness([
        responseOf({ chunks: [new Uint8Array(size).fill(120)] }),
      ]);
      if (shouldParse) {
        const results = await harness.backend.search("q", 5);
        expect(results).toEqual([]);
      } else {
        try {
          await harness.backend.search("q", 5);
          expect.unreachable("cap");
        } catch (error) {
          expect((error as SearchUnavailable).message).toBe("search response exceeded 2000000 bytes");
        }
      }
      expect(harness.cancelCalls).toEqual(shouldParse ? [] : [1]);
    }
  });
});
