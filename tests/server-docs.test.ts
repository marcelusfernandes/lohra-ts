import { describe, expect, it } from "vitest";

import { docsHtml, oauthRedirectHtml, openapiSchema, redocHtml } from "../src/server/docs.js";
import { chatCompletionBody } from "../src/server/chat-format.js";
import { PRODUCT_PATHS } from "../src/server/routes.js";

describe("openapiSchema — paths contains exactly the four product paths (assertion 14)", () => {
  it("declares only the product paths, not the doc routes themselves", () => {
    const schema = openapiSchema();
    expect(Object.keys(schema["paths"] as Record<string, unknown>).sort()).toEqual(
      [...PRODUCT_PATHS].sort(),
    );
  });

  it("serializes to valid compact JSON", () => {
    expect(() => chatCompletionBody(openapiSchema())).not.toThrow();
  });
});

describe("HTML doc pages", () => {
  it("docs/redoc/oauth2-redirect are non-empty HTML documents", () => {
    for (const html of [docsHtml(), redocHtml(), oauthRedirectHtml()]) {
      expect(html).toContain("<!DOCTYPE html>");
      expect(html.length).toBeGreaterThan(0);
    }
  });
});
