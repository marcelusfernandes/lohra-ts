import { describe, expect, it } from "vitest";

import { matchRoute, PRODUCT_PATHS } from "../src/server/routes.js";

describe("matchRoute — exact 8-handler surface, trailing-slash as router class", () => {
  it("lists exactly the four product paths for the openapi schema", () => {
    expect(PRODUCT_PATHS).toEqual([
      "/health",
      "/v1/models",
      "/v1/chat/completions",
      "/v1/responses",
    ]);
  });

  it("matches each of the 8 known handlers with its declared method", () => {
    expect(matchRoute("GET", "/health")).toEqual({
      kind: "route",
      name: "health",
      methods: ["GET"],
    });
    expect(matchRoute("GET", "/v1/models")).toEqual({
      kind: "route",
      name: "models",
      methods: ["GET"],
    });
    expect(matchRoute("POST", "/v1/chat/completions")).toEqual({
      kind: "route",
      name: "chatCompletions",
      methods: ["POST"],
    });
    expect(matchRoute("POST", "/v1/responses")).toEqual({
      kind: "route",
      name: "responses",
      methods: ["POST"],
    });
    expect(matchRoute("GET", "/openapi.json")).toEqual({
      kind: "route",
      name: "openapi",
      methods: ["GET"],
    });
    expect(matchRoute("GET", "/docs")).toEqual({ kind: "route", name: "docs", methods: ["GET"] });
    expect(matchRoute("GET", "/redoc")).toEqual({ kind: "route", name: "redoc", methods: ["GET"] });
    expect(matchRoute("GET", "/docs/oauth2-redirect")).toEqual({
      kind: "route",
      name: "oauthRedirect",
      methods: ["GET"],
    });
  });

  it("returns method-not-allowed with the correct Allow header for a known path, wrong method", () => {
    expect(matchRoute("POST", "/v1/models")).toEqual({ kind: "method-not-allowed", allow: "GET" });
    expect(matchRoute("OPTIONS", "/v1/chat/completions")).toEqual({
      kind: "method-not-allowed",
      allow: "POST",
    });
    expect(matchRoute("HEAD", "/health")).toEqual({ kind: "method-not-allowed", allow: "GET" });
  });

  it("returns a trailing-slash redirect for a known path + slash, any method (assertion 14/B7)", () => {
    expect(matchRoute("GET", "/docs/")).toEqual({ kind: "redirect", target: "/docs" });
    expect(matchRoute("GET", "/v1/chat/completions/")).toEqual({
      kind: "redirect",
      target: "/v1/chat/completions",
    });
    expect(matchRoute("POST", "/v1/chat/completions/")).toEqual({
      kind: "redirect",
      target: "/v1/chat/completions",
    });
  });

  it("returns not-found for /v1/runs, root, and the negative sweep (assertion 24/24a)", () => {
    for (const path of [
      "/",
      "/v1/runs",
      "/v1/runs/abc",
      "/v1/completions",
      "/v1/embeddings",
      "/metrics",
      "/v1/models/fake-model-a",
      "/v1/responses/resp_x",
      "/v1/nope",
    ]) {
      expect(matchRoute("GET", path)).toEqual({ kind: "not-found" });
      expect(matchRoute("POST", path)).toEqual({ kind: "not-found" });
    }
  });

  it("does not redirect a trailing slash on an otherwise-unknown path", () => {
    expect(matchRoute("GET", "/v1/nope/")).toEqual({ kind: "not-found" });
  });
});
