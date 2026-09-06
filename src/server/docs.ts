/** The single documentation route this server exposes: a minimal but valid
 * OpenAPI document whose `paths` lists exactly the product's four routes,
 * each with an `operationId` (issue #74 / ADR 0003 item 6 — `/docs`, `/redoc`
 * and the Swagger UI OAuth2 redirect page were removed; unknown routes,
 * including those, are a plain 404). */

import { PRODUCT_PATHS } from "./routes.js";

const OPERATION_IDS: Readonly<Record<string, string>> = {
  "/health": "health",
  "/v1/models": "listModels",
  "/v1/chat/completions": "createChatCompletion",
  "/v1/responses": "createResponse",
};

export function openapiSchema(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const path of PRODUCT_PATHS) {
    const method = path === "/v1/chat/completions" || path === "/v1/responses" ? "post" : "get";
    paths[path] = { [method]: { operationId: OPERATION_IDS[path] } };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Lohra OpenAI-compatible server",
      description: "OpenAI-compatible chat/completions surface exposed by `lohra serve`.",
      version: "0.0.11",
    },
    paths,
  };
}
