import { describe, expect, it } from "vitest";

import {
  firstHeaderValue,
  lastHeaderValue,
  parseHttpRequestHead,
} from "../../src/gateway/http/request-parser.js";

function raw(lines: readonly string[]): Buffer {
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "binary");
}

describe("parseHttpRequestHead", () => {
  it("parses the request line and headers in order", () => {
    const head = parseHttpRequestHead(
      raw(["GET /api/status HTTP/1.1", "Host: 127.0.0.1:9119", "X-Lohra-Session-Token: abc"]),
    );
    expect(head.method).toBe("GET");
    expect(head.path).toBe("/api/status");
    expect(head.httpVersion).toBe("1.1");
    expect(head.headers).toEqual([
      ["Host", "127.0.0.1:9119"],
      ["X-Lohra-Session-Token", "abc"],
    ]);
  });

  it("strips only leading OWS from a header value, preserving trailing OWS", () => {
    const head = parseHttpRequestHead(
      raw(["GET / HTTP/1.1", "Host: h", "X-Lohra-Session-Token:  leading-and-trailing  "]),
    );
    const [, value] = head.headers[1] as [string, string];
    expect(value).toBe("leading-and-trailing  ");
  });

  it("preserves duplicate headers in wire order for first/last-wins lookups", () => {
    const head = parseHttpRequestHead(
      raw([
        "GET / HTTP/1.1",
        "Host: h",
        "X-Lohra-Session-Token: good",
        "X-Lohra-Session-Token: bad",
      ]),
    );
    expect(head.headers.filter(([name]) => name === "X-Lohra-Session-Token")).toEqual([
      ["X-Lohra-Session-Token", "good"],
      ["X-Lohra-Session-Token", "bad"],
    ]);
  });

  it("parses method, path with query string, and trailing slash distinctly", () => {
    const head = parseHttpRequestHead(raw(["GET /api/status/?token=x HTTP/1.1", "Host: h"]));
    expect(head.path).toBe("/api/status/?token=x");
  });

  it("rejects a request line missing the HTTP version", () => {
    expect(() => parseHttpRequestHead(raw(["GET /"]))).toThrow();
  });
});

describe("firstHeaderValue", () => {
  it("returns the first matching header, case-insensitively", () => {
    const headers: [string, string][] = [
      ["x-lohra-session-token", "good"],
      ["X-Lohra-Session-Token", "bad"],
    ];
    expect(firstHeaderValue(headers, "X-Lohra-Session-Token")).toBe("good");
  });

  it("returns null when the header is absent", () => {
    expect(firstHeaderValue([["Host", "h"]], "X-Lohra-Session-Token")).toBeNull();
  });
});

describe("lastHeaderValue", () => {
  it("returns the last matching header, case-insensitively", () => {
    const headers: [string, string][] = [
      ["X-Lohra-Session-Token", "good"],
      ["x-lohra-session-token", "bad"],
    ];
    expect(lastHeaderValue(headers, "X-Lohra-Session-Token")).toBe("bad");
  });
});
