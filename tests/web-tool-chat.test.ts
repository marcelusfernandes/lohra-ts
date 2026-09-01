import { describe, expect, it } from "vitest";

import { ConversationRuntime, type ModelRequest, type ModelTransport } from "../src/conversation/index.js";
import { createBuiltinRegistry, toolError, toolResult } from "../src/tools/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";
import {
  coerceMaxResults,
  currentSearchBackend,
  currentWebTransport,
  setWebTransport,
  setSearchBackend,
  webFetchHandler,
  webSearchHandler,
  type WebTransport,
} from "../src/web/index.js";
import { SearchUnavailable } from "../src/web/search.js";
import { responseOf } from "./web-connector.test.js";
import type { Resolver } from "../src/web/index.js";

const encoder = new TextEncoder();

const table: Record<string, readonly string[]> = {
  "public.test": ["93.184.216.34"],
};

function makeResolver(calls: string[]): Resolver {
  return (host) => {
    calls.push(host);
    const ips = table[host];
    if (ips === undefined) throw new Error("fixture DNS failed");
    return ips.map((address) => ({ address, family: 4 }));
  };
}

function httpDouble(html: string): WebTransport {
  const calls: string[] = [];
  const requests: string[] = [];
  return {
    resolver: makeResolver(calls),
    connector: {
      request: (request) => {
        requests.push(request.url);
        return Promise.resolve(responseOf({ chunks: [encoder.encode(html)] }));
      },
    },
    metadata: { calls, requests },
  } as WebTransport & { metadata: { calls: string[]; requests: string[] } };
}

async function withDoubles<T>(run: () => Promise<T>): Promise<T> {
  const previousTransport = currentWebTransport();
  const previousBackend = currentSearchBackend();
  try {
    return await run();
  } finally {
    setWebTransport(previousTransport);
    setSearchBackend(previousBackend);
  }
}

describe("web tool envelopes and coercions", () => {
  it("returns the exact oracle missing-argument envelopes", async () => {
    await withDoubles(async () => {
      for (const url of [undefined, "", 0, false, true, ["x"], {}]) {
        expect(await webFetchHandler({ url })).toBe(
          toolError("missing required argument 'url' (string)"),
        );
      }
      for (const query of [undefined, "", "   ", 0, false, [], {}]) {
        expect(await webSearchHandler({ query })).toBe(
          toolError("missing required argument 'query' (string)"),
        );
      }
    });
  });

  it("preserves the original query value in the envelope while stringifying for the backend", async () => {
    await withDoubles(async () => {
      const received: Array<{ query: string; maxResults: number }> = [];
      setSearchBackend({
        search: (query, maxResults) => {
          received.push({ query, maxResults });
          return Promise.resolve([]);
        },
      });
      expect(await webSearchHandler({ query: true })).toBe(
        toolResult(undefined, { query: true, results: [] }),
      );
      expect(await webSearchHandler({ query: 7 })).toBe(
        toolResult(undefined, { query: 7, results: [] }),
      );
      expect(await webSearchHandler({ query: ["x"] })).toBe(
        toolResult(undefined, { query: ["x"], results: [] }),
      );
      expect(received.map((call) => call.query)).toEqual(["True", "7", "['x']"]);
    });
  });

  it("covers the full max_results coercion table", () => {
    expect(coerceMaxResults(undefined)).toBe(5);
    expect(coerceMaxResults(null)).toBe(5);
    expect(coerceMaxResults("nope")).toBe(5);
    expect(coerceMaxResults({})).toBe(5);
    expect(coerceMaxResults([])).toBe(5);
    expect(coerceMaxResults(0)).toBe(1);
    expect(coerceMaxResults(-9)).toBe(1);
    expect(coerceMaxResults(11)).toBe(10);
    expect(coerceMaxResults("7")).toBe(7);
    expect(coerceMaxResults(2.9)).toBe(2);
    expect(coerceMaxResults(true)).toBe(1);
    expect(coerceMaxResults(false)).toBe(1);
  });

  it("wraps transport failures in the oracle prefix with the url", async () => {
    await withDoubles(async () => {
      setWebTransport({
        resolver: () => {
          throw new Error("fixture DNS failed");
        },
        connector: { request: () => Promise.resolve(responseOf({})) },
      });
      expect(await webFetchHandler({ url: "http://public.test/" })).toBe(
        toolError("could not resolve host 'public.test': fixture DNS failed", {
          url: "http://public.test/",
        }),
      );
    });
  });

  it("delivers security causes as plain WebError envelopes", async () => {
    await withDoubles(async () => {
      setWebTransport({
        resolver: makeResolver([]),
        connector: {
          request: () =>
            Promise.resolve(responseOf({ peer: "1.2.3.4", chunks: [encoder.encode("never")] })),
        },
      });
      expect(await webFetchHandler({ url: "http://public.test/" })).toBe(
        toolError("refusing response from unvalidated peer: peer not in validated set", {
          url: "http://public.test/",
        }),
      );
    });
  });

  it("distinguishes search unavailable from generic web failure", async () => {
    await withDoubles(async () => {
      setSearchBackend({
        search: () => Promise.reject(new SearchUnavailable("search request failed: fixture connect failed")),
      });
      const unavailable = await webSearchHandler({ query: "q" });
      setSearchBackend({
        search: () => Promise.reject(new SearchUnavailable("search backend returned HTTP 302")),
      });
      const explicit = await webSearchHandler({ query: "q" });
      setSearchBackend({
        search: () => Promise.reject(new Error("fixture other")),
      });
      const generic = await webSearchHandler({ query: "q" });
      expect(unavailable).toBe(
        toolError(
          "search is unavailable right now: search request failed: fixture connect failed",
          { query: "q" },
        ),
      );
      expect(explicit).toBe(
        toolError("search is unavailable right now: search backend returned HTTP 302", {
          query: "q",
        }),
      );
      expect(generic).toBe(toolError("search failed: fixture other", { query: "q" }));
    });
  });
});

const usage = {
  inputTokens: 3,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

class QueueTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly responses: readonly NormalizedResponse[]) {}
  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) return Promise.reject(new Error("fixture response missing"));
    return Promise.resolve(response);
  }
  close(): void {}
}

const canned = (overrides: Partial<NormalizedResponse> = {}): NormalizedResponse => ({
  content: null,
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage,
  providerData: null,
  ...overrides,
});

describe("web tools through registry dispatch and a canned chat turn", () => {
  it("keeps web definitions registered in the web toolset without the fail-safe literal", () => {
    const registry = createBuiltinRegistry();
    const names = registry.namesInToolset("web");
    expect(names).toEqual(["web_fetch", "web_search"]);
    const definitions = registry
      .getDefinitions()
      .filter((definition) => names.includes(definition.function.name));
    for (const definition of definitions) {
      expect(definition.function.description).not.toContain("deferred");
    }
  });

  it("traverses ToolRegistry.dispatch and a canned runtime turn with the real handler", async () => {
    await withDoubles(async () => {
      const transport = httpDouble("<html><body>canned body</body></html>");
      setWebTransport(transport);
      const registry = createBuiltinRegistry();
      const dispatched = await registry.dispatch("web_fetch", { url: "http://public.test/" });
      expect(JSON.parse(dispatched)).toEqual({
        ok: true,
        url: "http://public.test/",
        text: "canned body",
      });

      const model = new QueueTransport([
        canned({
          finishReason: "tool_calls",
          toolCalls: [
            { id: "c1", name: "web_fetch", arguments: '{"url":"http://public.test/"}', providerData: null },
          ],
        }),
        canned({ content: "final answer" }),
      ]);
      const commits: unknown[] = [];
      const runtime = new ConversationRuntime({
        repository: {
          createSession: () => {},
          session: () => null,
          loadMessages: () => [],
          commitTurn: (commit) => {
            commits.push(commit);
          },
          commitUsage: () => {},
          summary: () => ({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            apiCallCount: 0,
            pricedCallCount: null,
            actualCostUsd: null,
            estimatedCostUsd: null,
          }),
        },
        transport: model,
        promptSnapshot: () => "frozen",
        toolDefinitions: registry.getDefinitions().filter((definition) =>
          ["web_fetch", "web_search"].includes(definition.function.name),
        ),
        toolDispatcher: {
          dispatch: async (call) => ({
            role: "tool",
            name: call.name,
            tool_call_id: call.id,
            content: await registry.dispatch(
              call.name,
              JSON.parse(call.arguments) as Record<string, unknown>,
            ),
          }),
        },
        idSource: () => "session-t20",
        clock: () => 1,
      });
      const result = await runtime.runTurn({ input: "fetch", provider: "stub", model: "m", cwd: "/tmp" });
      expect(result.response.content).toBe("final answer");
      expect(model.requests).toHaveLength(2);
      const resent = model.requests[1]?.messages ?? [];
      const toolMessage = resent.find(
        (message) => (message as { role?: string }).role === "tool",
      ) as { content?: string } | undefined;
      expect(JSON.parse(toolMessage?.content ?? "{}")).toEqual({
        ok: true,
        url: "http://public.test/",
        text: "canned body",
      });
    });
  });
});

import { describe as _d, it as _it } from "vitest";
void _it;
void _d;

describe("egress guard", () => {
  it("fails fatally on any socket or dns egress attempt with the default wiring", async () => {
    const net = await import("node:net");
    const dns = await import("node:dns");
    const socketPrototype = net.Socket.prototype;
    const originalConnect = Object.getOwnPropertyDescriptor(socketPrototype, "connect")
      ?.value as (typeof socketPrototype)["connect"];
    const dnsPromises = dns.promises;
    const originalLookup = Object.getOwnPropertyDescriptor(dnsPromises, "lookup")
      ?.value as (typeof dnsPromises)["lookup"];

    const fatal = (): never => {
      throw new Error("EGRESS_FORBIDDEN");
    };
    const patch = (owner: object, name: string, value: unknown): void => {
      Object.defineProperty(owner, name, { value, configurable: true });
    };
    patch(net.Socket.prototype, "connect", fatal);
    patch(dnsPromises, "lookup", fatal);
    try {
      const result = await webFetchHandler({ url: "http://public.test/" });
      expect(result).toContain("EGRESS_FORBIDDEN");
    } finally {
      patch(net.Socket.prototype, "connect", originalConnect);
      patch(dnsPromises, "lookup", originalLookup);
    }
  });
});
