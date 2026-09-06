import { describe, expect, it } from "vitest";

import { parseHttpRequestHead } from "../../src/gateway/http/request-parser.js";
import {
  documentedAndAbsentRestRoutes,
  routeGatewayRequest,
  type RouteContext,
} from "../../src/gateway/http/routes.js";

const TOKEN = "the-expected-token";

function head(
  method: string,
  path: string,
  extraHeaders: readonly string[] = [],
): ReturnType<typeof parseHttpRequestHead> {
  return parseHttpRequestHead(
    Buffer.from(
      `${[`${method} ${path} HTTP/1.1`, "Host: 127.0.0.1:9119", ...extraHeaders].join("\r\n")}\r\n\r\n`,
      "binary",
    ),
  );
}

function context(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    expectedToken: TOKEN,
    authRequired: true,
    handlers: {
      status: () => ({ ok: true, version: "0.0.11", sessions: 0 }),
      sessions: () => ({ sessions: [] }),
      messages: () => ({ messages: [] }),
      config: () => ({ version: "0.0.11", auth_required: true }),
    },
    ...overrides,
  };
}

function authed(path: string, method = "GET"): ReturnType<typeof head> {
  return head(method, path, [`X-Lohra-Session-Token: ${TOKEN}`]);
}

describe("routeGatewayRequest: auth precedes routing (assertion 14)", () => {
  it("unknown /api path without token -> 401; with valid token -> 404", () => {
    const noToken = routeGatewayRequest(head("GET", "/api/does-not-exist"), context());
    expect(noToken.status).toBe(401);
    expect(JSON.parse(noToken.body.toString())).toEqual({ detail: "Unauthorized" });

    const withToken = routeGatewayRequest(authed("/api/does-not-exist"), context());
    expect(withToken.status).toBe(404);
    expect(JSON.parse(withToken.body.toString())).toEqual({ detail: "Not Found" });
  });

  it("/api exact follows the same pattern", () => {
    expect(routeGatewayRequest(head("GET", "/api"), context()).status).toBe(401);
    expect(routeGatewayRequest(authed("/api"), context()).status).toBe(404);
  });

  it("/apifoo (no slash) is 404 regardless of token -- not covered by the /api prefix", () => {
    expect(routeGatewayRequest(head("GET", "/apifoo"), context()).status).toBe(404);
    expect(routeGatewayRequest(authed("/apifoo"), context()).status).toBe(404);
  });
});

describe("routeGatewayRequest: envelope and header matrix (assertion 15)", () => {
  it("real routes require the exact token, with the {detail:Unauthorized} envelope", () => {
    const response = routeGatewayRequest(head("GET", "/api/status"), context());
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body.toString())).toEqual({ detail: "Unauthorized" });
  });

  it("header name is case-insensitive", () => {
    const response = routeGatewayRequest(
      head("GET", "/api/status", [`x-lohra-session-token: ${TOKEN}`]),
      context(),
    );
    expect(response.status).toBe(200);
  });

  it("first duplicate header wins", () => {
    const goodThenBad = routeGatewayRequest(
      head("GET", "/api/status", [
        `X-Lohra-Session-Token: ${TOKEN}`,
        "X-Lohra-Session-Token: wrong",
      ]),
      context(),
    );
    expect(goodThenBad.status).toBe(200);

    const badThenGood = routeGatewayRequest(
      head("GET", "/api/status", [
        "X-Lohra-Session-Token: wrong",
        `X-Lohra-Session-Token: ${TOKEN}`,
      ]),
      context(),
    );
    expect(badThenGood.status).toBe(401);
  });

  it("token in the Authorization header instead is rejected", () => {
    const response = routeGatewayRequest(
      head("GET", "/api/status", [`Authorization: Bearer ${TOKEN}`]),
      context(),
    );
    expect(response.status).toBe(401);
  });

  it("trailing OWS on the token is rejected, leading OWS is accepted", () => {
    const trailing = routeGatewayRequest(
      head("GET", "/api/status", [`X-Lohra-Session-Token: ${TOKEN}  `]),
      context(),
    );
    expect(trailing.status).toBe(401);

    const leading = routeGatewayRequest(
      head("GET", "/api/status", [`X-Lohra-Session-Token:   ${TOKEN}`]),
      context(),
    );
    expect(leading.status).toBe(200);
  });
});

describe("routeGatewayRequest: OPTIONS exemption and enumeration oracle (assertion 16)", () => {
  it("OPTIONS on an existing route -> 405 without a token", () => {
    const response = routeGatewayRequest(head("OPTIONS", "/api/status"), context());
    expect(response.status).toBe(405);
  });

  it("OPTIONS on a non-existent route -> 404 without a token", () => {
    const response = routeGatewayRequest(head("OPTIONS", "/api/does-not-exist"), context());
    expect(response.status).toBe(404);
  });

  it("HEAD /api/status with token -> 405 empty body, json content-type", () => {
    const response = routeGatewayRequest(authed("/api/status", "HEAD"), context());
    expect(response.status).toBe(405);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body.length).toBe(0);
  });

  it("GET /api/status/ with token -> 307 redirect derived from Host; without token -> 401", () => {
    const withToken = routeGatewayRequest(authed("/api/status/"), context());
    expect(withToken.status).toBe(307);
    expect(withToken.headers.location).toBe("http://127.0.0.1:9119/api/status");

    const withoutToken = routeGatewayRequest(head("GET", "/api/status/"), context());
    expect(withoutToken.status).toBe(401);
  });
});

describe("routeGatewayRequest: Location host derivation is verbatim and unvalidated (L23)", () => {
  it("reflects a bare Host with no port", () => {
    const request = parseHttpRequestHead(
      Buffer.from(
        "GET /api/status/ HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Lohra-Session-Token: the-expected-token\r\n\r\n",
      ),
    );
    const response = routeGatewayRequest(request, context());
    expect(response.headers.location).toBe("http://127.0.0.1/api/status");
  });

  it("reflects an arbitrary, unrelated Host without validation", () => {
    const request = parseHttpRequestHead(
      Buffer.from(
        "GET /api/status/ HTTP/1.1\r\nHost: evil.example:8080\r\nX-Lohra-Session-Token: the-expected-token\r\n\r\n",
      ),
    );
    const response = routeGatewayRequest(request, context());
    expect(response.headers.location).toBe("http://evil.example:8080/api/status");
  });
});

describe("routeGatewayRequest: GET /health is absent (assertion 13, R13 -- the T11 copy-paste trap)", () => {
  it("is 404 with and without a token -- it is not an /api path at all", () => {
    expect(routeGatewayRequest(head("GET", "/health"), context()).status).toBe(404);
    expect(routeGatewayRequest(authed("/health"), context()).status).toBe(404);
  });
});

describe("routeGatewayRequest: docs and no SPA (assertion 17)", () => {
  it.each(["/", "/index.html", "/assets/app.js", "/favicon.ico"])(
    "%s -> 404 with and without token, never a SPA",
    (path) => {
      expect(routeGatewayRequest(head("GET", path), context()).status).toBe(404);
      expect(routeGatewayRequest(authed(path), context()).status).toBe(404);
    },
  );

  it("openapi.json is open, 200, and paths contains exactly the 4 real routes -- no /api/ws", () => {
    const response = routeGatewayRequest(head("GET", "/openapi.json"), context());
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body.toString()) as { paths: Record<string, unknown> };
    expect(Object.keys(body.paths).sort()).toEqual(
      ["/api/config", "/api/sessions", "/api/sessions/{session_id}/messages", "/api/status"].sort(),
    );
  });

  it("every path in openapi.json carries an operationId under its GET method (issue #74)", () => {
    const response = routeGatewayRequest(head("GET", "/openapi.json"), context());
    const body = JSON.parse(response.body.toString()) as {
      paths: Record<string, { get?: { operationId?: string } }>;
    };
    for (const [path, item] of Object.entries(body.paths)) {
      expect(item.get?.operationId, path).toEqual(expect.any(String));
      expect(item.get?.operationId, path).not.toBe("");
    }
  });

  it("info.version stays 0.1.0 -- this gateway's own doc, not the package version", () => {
    const response = routeGatewayRequest(head("GET", "/openapi.json"), context());
    const body = JSON.parse(response.body.toString()) as { info: { version: string } };
    expect(body.info.version).toBe("0.1.0");
  });

  it.each(["/docs", "/redoc", "/docs/oauth2-redirect"])(
    "%s is removed (issue #74) -- 404 like any unknown route",
    (path) => {
      expect(routeGatewayRequest(head("GET", path), context()).status).toBe(404);
      expect(routeGatewayRequest(authed(path), context()).status).toBe(404);
    },
  );

  it("/docs/ is also just an unknown route now -- 404, no redirect", () => {
    const response = routeGatewayRequest(head("GET", "/docs/"), context());
    expect(response.status).toBe(404);
  });
});

describe("routeGatewayRequest: 25-route negative sweep (assertion 18)", () => {
  it("every documented-and-absent route is 404-with-token / 401-without-token, except PUT /api/config -> 405", () => {
    for (const route of documentedAndAbsentRestRoutes()) {
      const withoutToken = routeGatewayRequest(head(route.method, route.path), context());
      expect(withoutToken.status, `${route.method} ${route.path} without token`).toBe(401);

      const withToken = routeGatewayRequest(authed(route.path, route.method), context());
      const expected = route.method === "PUT" && route.path === "/api/config" ? 405 : 404;
      expect(withToken.status, `${route.method} ${route.path} with token`).toBe(expected);
    }
  });

  it("has exactly 25 named routes", () => {
    expect(documentedAndAbsentRestRoutes()).toHaveLength(25);
  });
});

describe("routeGatewayRequest: --insecure mode (auth_required:false)", () => {
  it("serves /api/status without a token when authRequired is false", () => {
    const response = routeGatewayRequest(
      head("GET", "/api/status"),
      context({ authRequired: false }),
    );
    expect(response.status).toBe(200);
  });

  it("still serves it with a bogus token supplied", () => {
    const response = routeGatewayRequest(
      head("GET", "/api/status", ["X-Lohra-Session-Token: totally-wrong"]),
      context({ authRequired: false }),
    );
    expect(response.status).toBe(200);
  });
});
