/** The four documentation routes exposed for deliberate parity (contract v2
 * decision 1): a minimal but valid OpenAPI document whose `paths` lists
 * exactly the four product paths, and static HTML for /docs, /redoc, and the
 * Swagger UI OAuth2 redirect page. Byte content isn't contract-asserted —
 * only "200 HTML without auth" is — so this is a plain, self-contained page
 * per route, not a faithful FastAPI/Swagger-UI/ReDoc reproduction. */

import { PRODUCT_PATHS } from "./routes.js";

export function openapiSchema(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const path of PRODUCT_PATHS) paths[path] = {};
  return {
    openapi: "3.1.0",
    info: { title: "Lohra OpenAI-compatible server", version: "0.0.11" },
    paths,
  };
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>\n`;
}

export function docsHtml(): string {
  return page("Lohra OpenAI-compatible server - Swagger UI", "<div id=\"swagger-ui\"></div>");
}

export function redocHtml(): string {
  return page("Lohra OpenAI-compatible server - ReDoc", "<redoc spec-url=\"/openapi.json\"></redoc>");
}

export function oauthRedirectHtml(): string {
  return page("Swagger UI: OAuth2 Redirect", "<script>window.close();</script>");
}
