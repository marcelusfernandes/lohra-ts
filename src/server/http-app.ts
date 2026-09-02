/** The OpenAI-compatible HTTP/SSE server — mirrors `create_openai_app` from
 * lohra/server/app.py. Raw node:http, not a framework: every 404/405/422
 * body and every header is contract-specified, and a framework's own
 * defaults (its own 404 shape, its own JSON-parse error format) would be a
 * parity bug to override rather than behavior to rely on. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { authorized } from "./auth.js";
import { handleChatCompletions } from "./chat-handler.js";
import { buildModelsList } from "./chat-format.js";
import { docsHtml, oauthRedirectHtml, openapiSchema, redocHtml } from "./docs.js";
import { writeHtml, writeJson, writeRedirect } from "./http-io.js";
import { matchRoute } from "./routes.js";
import { handleResponses } from "./responses-handler.js";
import type { CompletionService } from "./service.js";

const LOHRA_VERSION = "0.0.11";

export interface OpenAiServerOptions {
  readonly service: CompletionService;
  readonly apiKey: string | null;
  readonly models: readonly string[];
}

function handleModels(
  req: IncomingMessage,
  res: ServerResponse,
  options: OpenAiServerOptions,
): void {
  if (!authorized(req.headers.authorization, options.apiKey)) {
    writeJson(res, 401, {
      error: { message: "missing or invalid API key", type: "authentication_error" },
    });
    return;
  }
  writeJson(res, 200, buildModelsList(options.models, { created: Math.floor(Date.now() / 1000) }));
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  options: OpenAiServerOptions,
): Promise<void> {
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", "http://placeholder.invalid").pathname;
  const match = matchRoute(method, pathname);

  switch (match.kind) {
    case "not-found":
      writeJson(res, 404, { detail: "Not Found" });
      return;
    case "method-not-allowed":
      writeJson(res, 405, { detail: "Method Not Allowed" }, { allow: match.allow });
      return;
    case "redirect":
      writeRedirect(res, req.headers.host, match.target);
      return;
    case "route":
      break;
  }

  switch (match.name) {
    case "health":
      writeJson(res, 200, { ok: true, version: LOHRA_VERSION });
      return;
    case "models":
      handleModels(req, res, options);
      return;
    case "openapi":
      writeJson(res, 200, openapiSchema());
      return;
    case "docs":
      writeHtml(res, docsHtml());
      return;
    case "redoc":
      writeHtml(res, redocHtml());
      return;
    case "oauthRedirect":
      writeHtml(res, oauthRedirectHtml());
      return;
    case "chatCompletions":
      await handleChatCompletions(req, res, options);
      return;
    case "responses":
      await handleResponses(req, res, options);
      return;
  }
}

export function createOpenAiServer(options: OpenAiServerOptions): Server {
  return createServer((req, res) => {
    dispatch(req, res, options).catch((error: unknown) => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: { message: "internal server error", type: "server_error" } });
      } else {
        res.destroy();
      }
      process.stderr.write(
        `t11 server handler error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
    });
  });
}
