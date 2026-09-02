import { describe, expect, it } from "vitest";

import { fetchUrl, isTextualContentType } from "../src/web/index.js";
import { responseOf, recordedConnector } from "./web-connector.test.js";
import type { ConnectorResponse, Resolver } from "../src/web/index.js";

const PUBLIC = "93.184.216.34";

const table: Record<string, readonly string[]> = {
  "public.test": [PUBLIC],
  "private.test": ["10.0.0.5"],
  "hop.test": [PUBLIC],
  "mixed.test": [PUBLIC, "10.0.0.5"],
};

function makeResolver(calls: string[]): Resolver {
  return (host) => {
    calls.push(host);
    const ips = table[host];
    if (ips === undefined) throw new Error("fixture DNS failed");
    return ips.map((address) => ({ address, family: host.includes(":") ? 6 : 4 }));
  };
}

const encoder = new TextEncoder();

function fixture(responses: readonly ConnectorResponse[], clock?: () => number) {
  const resolverCalls: string[] = [];
  const { connector, requests, cancelCalls } = recordedConnector(responses);
  return {
    requests,
    cancelCalls,
    resolverCalls,
    deps: {
      resolver: makeResolver(resolverCalls),
      connector,
      ...(clock === undefined ? {} : { clock }),
    },
  };
}

async function fetchWith(
  responses: readonly ConnectorResponse[],
  url: string,
  overrides: { readonly clock?: () => number; readonly maxBytes?: number } = {},
) {
  const harness = fixture(responses, overrides.clock);
  const outcome = await fetchUrl(url, {
    ...harness.deps,
    ...(overrides.maxBytes === undefined ? {} : { maxBytes: overrides.maxBytes }),
  });
  return {
    ...outcome,
    requests: harness.requests,
    cancelCalls: harness.cancelCalls,
    resolverCalls: harness.resolverCalls,
  };
}

async function fetchError(
  responses: readonly ConnectorResponse[],
  url: string,
  overrides: { readonly clock?: () => number; readonly maxBytes?: number } = {},
): Promise<{
  cause: string;
  requestedUrls: string[];
  cancelCalls: number[];
  resolverCalls: string[];
  requestsMade: number;
}> {
  const harness = fixture(responses, overrides.clock);
  try {
    await fetchUrl(url, {
      ...harness.deps,
      ...(overrides.maxBytes === undefined ? {} : { maxBytes: overrides.maxBytes }),
    });
  } catch (error) {
    return {
      cause: error instanceof Error ? error.message : String(error),
      requestedUrls: harness.requests.map((request) => request.url),
      cancelCalls: harness.cancelCalls,
      resolverCalls: harness.resolverCalls,
      requestsMade: harness.requests.length,
    };
  }
  throw new Error("expected fetch to fail");
}

describe("fetch request semantics", () => {
  it("uses the oracle user agent, a 10 second deadline, and no automatic redirects", async () => {
    const now = 0;
    const outcome = await fetchWith(
      [responseOf({ chunks: [encoder.encode("hello")] })],
      "http://public.test/a",
      { clock: () => now },
    );
    expect(outcome.text).toBe("hello");
    expect(outcome.requests[0]?.headers["user-agent"]).toBe(
      "lohra-web/0.1 (+https://github.com/lohra)",
    );
    expect(outcome.requests[0]?.timeoutSeconds).toBe(10);
    expect(outcome.requests[0]?.deadlineMs).toBe(10_000);
    expect(outcome.requests).toHaveLength(1);
  });

  it("follows relative, protocol-relative and cross-host redirects with per-hop validation", async () => {
    const outcome = await fetchWith(
      [
        responseOf({ status: 302, headers: { location: "/b" } }),
        responseOf({ status: 302, headers: { location: "//hop.test/c" } }),
        responseOf({ status: 301, headers: { location: "https://hop.test/d" } }),
        responseOf({ chunks: [encoder.encode("final")] }),
      ],
      "http://public.test/a",
    );
    expect(outcome.text).toBe("final");
    expect(outcome.requests.map((request) => request.url)).toEqual([
      "http://public.test/a",
      "http://public.test/b",
      "http://hop.test/c",
      "https://hop.test/d",
    ]);
    expect(outcome.resolverCalls).toEqual(["public.test", "public.test", "hop.test", "hop.test"]);
  });

  it("covers the 301/302/303/307/308 status matrix", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const outcome = await fetchWith(
        [
          responseOf({ status, headers: { location: "/b" } }),
          responseOf({ chunks: [encoder.encode("ok")] }),
        ],
        "http://public.test/",
      );
      expect(outcome.text).toBe("ok");
      expect(outcome.requests).toHaveLength(2);
    }
  });

  it("follows four redirects to the body and fails the fifth after five requests", async () => {
    const arrived = await fetchWith(
      [
        responseOf({ status: 302, headers: { location: "/2" } }),
        responseOf({ status: 302, headers: { location: "/3" } }),
        responseOf({ status: 302, headers: { location: "/4" } }),
        responseOf({ status: 302, headers: { location: "/5" } }),
        responseOf({ chunks: [encoder.encode("arrived")] }),
      ],
      "http://public.test/1",
    );
    expect(arrived.text).toBe("arrived");
    expect(arrived.requests).toHaveLength(5);

    const exhausted = await fetchError(
      [
        responseOf({ status: 302, headers: { location: "/2" } }),
        responseOf({ status: 302, headers: { location: "/3" } }),
        responseOf({ status: 302, headers: { location: "/4" } }),
        responseOf({ status: 302, headers: { location: "/5" } }),
        responseOf({ status: 302, headers: { location: "/6" } }),
        responseOf({ chunks: [encoder.encode("never")] }),
      ],
      "http://public.test/1",
    );
    expect(exhausted.cause).toBe("too many redirects (more than 4)");
    expect(exhausted.requestsMade).toBe(5);
  });

  it("cancels every intermediate redirect stream before the next hop", async () => {
    const arrived = await fetchWith(
      [
        responseOf({ status: 302, headers: { location: "/b" } }),
        responseOf({ status: 302, headers: { location: "//hop.test/c" } }),
        responseOf({ chunks: [encoder.encode("final")] }),
      ],
      "http://public.test/a",
    );
    expect(arrived.text).toBe("final");
    expect(arrived.cancelCalls).toEqual([1, 2]);
    expect(arrived.requests).toHaveLength(3);
    expect(arrived.resolverCalls).toEqual(["public.test", "public.test", "hop.test"]);
  });

  it("cancels the current stream on missing Location and on redirect exhaustion", async () => {
    const noLocation = await fetchError(
      [responseOf({ status: 302, headers: {} })],
      "http://public.test/",
    );
    expect(noLocation.cause).toBe("redirect response had no Location header");
    expect(noLocation.cancelCalls).toEqual([1]);

    const exhausted = await fetchError(
      [
        responseOf({ status: 302, headers: { location: "/2" } }),
        responseOf({ status: 302, headers: { location: "/3" } }),
        responseOf({ status: 302, headers: { location: "/4" } }),
        responseOf({ status: 302, headers: { location: "/5" } }),
        responseOf({ status: 302, headers: { location: "/6" } }),
      ],
      "http://public.test/start",
    );
    expect(exhausted.cause).toBe("too many redirects (more than 4)");
    expect(exhausted.cancelCalls).toEqual([1, 2, 3, 4, 5]);
  });

  it("fails closed on redirect without Location and unsafe redirect targets", async () => {
    const noLocation = await fetchError([responseOf({ status: 302 })], "http://public.test/");
    expect(noLocation.cause).toBe("redirect response had no Location header");
    expect(noLocation.requestsMade).toBe(1);

    const userinfo = await fetchError(
      [responseOf({ status: 302, headers: { location: "http://alice:secret@public.test/" } })],
      "http://public.test/",
    );
    expect(userinfo.cause).toBe("refusing URL with embedded credentials");
    expect(userinfo.requestsMade).toBe(1);

    const scheme = await fetchError(
      [responseOf({ status: 302, headers: { location: "ftp://public.test/x" } })],
      "http://public.test/",
    );
    expect(scheme.cause).toBe("unsupported URL scheme: 'ftp' (http/https only)");
    expect(scheme.requestsMade).toBe(1);

    const privateTarget = await fetchError(
      [responseOf({ status: 302, headers: { location: "http://private.test/" } })],
      "http://public.test/",
    );
    expect(privateTarget.cause).toBe(
      "refusing to fetch a non-public address: 10.0.0.5 (host 'private.test')",
    );
    expect(privateTarget.requestsMade).toBe(1);
    expect(privateTarget.resolverCalls).toEqual(["public.test", "private.test"]);
  });

  it("proves SSRF direct refusal with zero requests and mixed-DNS whole-set refusal", async () => {
    const direct = await fetchError([], "http://private.test/");
    expect(direct.cause).toBe(
      "refusing to fetch a non-public address: 10.0.0.5 (host 'private.test')",
    );
    expect(direct.requestsMade).toBe(0);
    expect(direct.resolverCalls).toEqual(["private.test"]);

    const mixed = await fetchError([], "http://mixed.test/");
    expect(mixed.cause).toBe(
      "refusing to fetch a non-public address: 10.0.0.5 (host 'mixed.test')",
    );
    expect(mixed.requestsMade).toBe(0);
  });

  it("maps resolver failure to the oracle cause with R=1 C=0", async () => {
    const harness = fixture([]);
    try {
      await fetchUrl("http://missing.test/", {
        ...harness.deps,
        resolver: () => {
          throw new Error("fixture DNS failed");
        },
      });
      expect.unreachable("resolver");
    } catch (error) {
      expect((error as Error).message).toBe(
        "could not resolve host 'missing.test': fixture DNS failed",
      );
    }
  });
});

describe("fetch peer hardening (expected divergences)", () => {
  it("refuses a divergent public peer before any body byte", async () => {
    const failure = await fetchError(
      [responseOf({ peer: "1.2.3.4", chunks: [encoder.encode("SIMULATED")] })],
      "http://public.test/",
    );
    expect(failure.cause).toBe(
      "refusing response from unvalidated peer: peer not in validated set",
    );
  });

  it("refuses rebinding after redirect before the second body", async () => {
    const failure = await fetchError(
      [
        responseOf({ status: 302, headers: { location: "http://hop.test/" }, peer: PUBLIC }),
        responseOf({
          peer: "1.2.3.4",
          chunks: [encoder.encode("SIMULATED_REDIRECT_PRIVATE_BODY")],
        }),
      ],
      "http://public.test/",
    );
    expect(failure.cause).toBe(
      "refusing response from unvalidated peer: peer not in validated set",
    );
  });

  it("refuses an unavailable peer", async () => {
    const failure = await fetchError(
      [responseOf({ peer: null, chunks: [encoder.encode("never")] })],
      "http://public.test/",
    );
    expect(failure.cause).toBe("refusing response from unvalidated peer: peer unavailable");
  });
});

describe("fetch bounds, content types and encodings", () => {
  it("returns truncated success at the 1999999/2000000/2000001 byte matrix", async () => {
    const below = await fetchWith(
      [responseOf({ chunks: [new Uint8Array(1_999_999).fill(97)] })],
      "http://public.test/",
    );
    expect(below.stats.bufferedBytes).toBe(1_999_999);
    expect(below.stats.cancelled).toBe(false);
    const exact = await fetchWith(
      [responseOf({ chunks: [new Uint8Array(2_000_000).fill(97)] })],
      "http://public.test/",
    );
    expect(exact.stats.bufferedBytes).toBe(2_000_000);
    expect(exact.stats.cancelled).toBe(true);
    expect(exact.cancelCalls).toEqual([1]);
    const above = await fetchWith(
      [responseOf({ chunks: [new Uint8Array(2_000_001).fill(97)] })],
      "http://public.test/",
    );
    expect(above.stats.bufferedBytes).toBe(2_000_000);
    expect(above.stats.cancelled).toBe(true);
  });

  it("stops reading and cancels exactly at the cap across chunk boundaries", async () => {
    const big = new Uint8Array(1_500_000).fill(97);
    const outcome = await fetchWith([responseOf({ chunks: [big, big] })], "http://public.test/", {
      maxBytes: 2_000_000,
    });
    expect(outcome.stats.bufferedBytes).toBe(2_000_000);
    expect(outcome.stats.readCalls).toBe(2);
    expect(outcome.stats.cancelled).toBe(true);
    expect(outcome.cancelCalls).toEqual([1]);

    const crossed = await fetchWith(
      [
        responseOf({
          chunks: [new Uint8Array(1_000_000).fill(97), new Uint8Array(1_000_001).fill(98)],
        }),
      ],
      "http://public.test/",
      { maxBytes: 2_000_000 },
    );
    expect(crossed.stats.bufferedBytes).toBe(2_000_000);
    expect(crossed.stats.readCalls).toBe(2);
    expect(crossed.stats.cancelled).toBe(true);
  });

  it("keeps the app buffer bounded for a single oversized chunk", async () => {
    const outcome = await fetchWith(
      [responseOf({ chunks: [new Uint8Array(3_000_000).fill(99)] })],
      "http://public.test/",
    );
    expect(outcome.stats.bufferedBytes).toBe(2_000_000);
    expect(outcome.stats.readCalls).toBe(1);
  });

  it("covers the permissive content-type table", () => {
    for (const type of [
      "",
      "text/plain",
      "text/html; charset=utf-8",
      "application/json",
      "application/xml",
      "application/javascript",
      "text/csv",
      "image/svg+xml",
      "application/jsonp",
      "x-anything/htmlish",
    ]) {
      expect(isTextualContentType(type), type).toBe(true);
    }
    for (const type of ["image/png", "application/octet-stream"]) {
      expect(isTextualContentType(type), type).toBe(false);
    }
  });

  it("refuses binary content with the exact cause", async () => {
    const failure = await fetchError(
      [responseOf({ headers: { "content-type": "image/png" }, chunks: [encoder.encode("never")] })],
      "http://public.test/",
    );
    expect(failure.cause).toBe(
      "content is not text (Content-Type: image/png); web_fetch only reads text pages",
    );
  });

  it("accepts missing content type and a textual HTTP 500 as success", async () => {
    const noType = await fetchWith(
      [responseOf({ headers: {}, chunks: [encoder.encode("body")] })],
      "http://public.test/",
    );
    expect(noType.text).toBe("body");
    const status500 = await fetchWith(
      [responseOf({ status: 500, chunks: [encoder.encode("err text")] })],
      "http://public.test/",
    );
    expect(status500.text).toBe("err text");
  });

  it("decodes declared charsets, falls back to utf-8 and replaces invalid bytes", async () => {
    const latin = await fetchWith(
      [
        responseOf({
          headers: { "content-type": "text/plain; charset=iso-8859-1" },
          chunks: [new Uint8Array([0xff, 0xfe])],
        }),
      ],
      "http://public.test/",
    );
    expect(latin.text).toBe("ÿþ");

    const invalid = await fetchWith(
      [responseOf({ chunks: [encoder.encode("abc"), new Uint8Array([0xff])] })],
      "http://public.test/",
    );
    expect(invalid.text).toBe("abc\uFFFD");

    const cut = await fetchWith(
      [responseOf({ chunks: [new Uint8Array([0x61, 0xe4, 0xb8])] })],
      "http://public.test/",
      { maxBytes: 3 },
    );
    expect(Array.from(cut.text)).toEqual(["a", "\ufffd"]);
  });
});

describe("fetch transport failures", () => {
  it("maps connector errors through the transport envelope cause", async () => {
    try {
      await fetchUrl("http://public.test/", {
        resolver: makeResolver([]),
        connector: {
          request: () => Promise.reject(new Error("fixture connect failed")),
        },
      });
      expect.unreachable("connect");
    } catch (error) {
      expect((error as Error).message).toBe("fixture connect failed");
    }
  });

  it("proves the timeout by an injected clock without sleep", async () => {
    const now = 0;
    try {
      await fetchUrl("http://public.test/", {
        resolver: makeResolver([]),
        connector: {
          request: (request) => {
            expect(request.deadlineMs).toBe(10_000);
            return Promise.reject(new Error("fixture timeout after 10 seconds"));
          },
        },
        clock: () => now,
      });
      expect.unreachable("timeout");
    } catch (error) {
      expect((error as Error).message).toBe("fixture timeout after 10 seconds");
    }
  });

  it("proves stream abort with registered bytes", async () => {
    try {
      await fetchUrl("http://public.test/", {
        resolver: makeResolver([]),
        connector: {
          request: () =>
            Promise.resolve(
              responseOf({
                chunks: [encoder.encode("partial")],
                stream: {
                  next: () => Promise.reject(new Error("fixture stream aborted")),
                  cancel: () => Promise.resolve(),
                },
              }),
            ),
        },
      });
      expect.unreachable("stream abort");
    } catch (error) {
      expect((error as Error).message).toBe("fixture stream aborted");
    }
  });
});
