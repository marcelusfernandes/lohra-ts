import { timingSafeTokenEqual } from "../auth.js";
import { firstHeaderValue, type ParsedRequestHead } from "./request-parser.js";
import { htmlResponse, jsonResponse, type OutgoingHttpResponse } from "./response.js";

const TOKEN_HEADER = "X-Lohra-Session-Token";

// The 25 documented REST routes absent from this oracle commit (T12
// baseline L22 / assertion 18). PUT /api/config is the sole exception --
// the path exists as GET only, so it resolves as a 405, not a 404.
const DOCUMENTED_AND_ABSENT_REST_ROUTES: readonly { method: string; path: string }[] = [
  { method: "GET", path: "/api/env" },
  { method: "PUT", path: "/api/env" },
  { method: "DELETE", path: "/api/env" },
  { method: "GET", path: "/api/model/info" },
  { method: "GET", path: "/api/model/options" },
  { method: "GET", path: "/api/model/auxiliary" },
  { method: "POST", path: "/api/model/set" },
  { method: "GET", path: "/api/skills" },
  { method: "PUT", path: "/api/skills/toggle" },
  { method: "GET", path: "/api/cron/jobs" },
  { method: "POST", path: "/api/cron/jobs" },
  { method: "GET", path: "/api/profiles" },
  { method: "POST", path: "/api/profiles" },
  { method: "GET", path: "/api/auth/me" },
  { method: "POST", path: "/api/auth/ws-ticket" },
  { method: "PATCH", path: "/api/sessions/abc" },
  { method: "DELETE", path: "/api/sessions/abc" },
  { method: "POST", path: "/api/sessions/bulk-delete" },
  { method: "POST", path: "/api/sessions/prune" },
  { method: "GET", path: "/api/config/schema" },
  { method: "GET", path: "/api/credentials/pool" },
  { method: "POST", path: "/api/providers/validate" },
  { method: "GET", path: "/api/providers/oauth" },
  { method: "GET", path: "/api/tools/toolsets" },
  { method: "PUT", path: "/api/config" },
];

export function documentedAndAbsentRestRoutes(): readonly { method: string; path: string }[] {
  return DOCUMENTED_AND_ABSENT_REST_ROUTES;
}

export interface RouteHandlers {
  readonly status: () => { readonly ok: true; readonly version: string; readonly sessions: number };
  readonly sessions: () => { readonly sessions: readonly unknown[] };
  readonly messages: (sessionId: string) => { readonly messages: readonly unknown[] };
  readonly config: () => { readonly version: string; readonly auth_required: boolean };
}

export interface RouteContext {
  readonly expectedToken: string;
  readonly authRequired: boolean;
  readonly handlers: RouteHandlers;
}

const UNAUTHORIZED = jsonResponse(401, { detail: "Unauthorized" });
const NOT_FOUND = jsonResponse(404, { detail: "Not Found" });
const METHOD_NOT_ALLOWED = jsonResponse(405, { detail: "Method Not Allowed" });

const OPENAPI_DOCUMENT: Readonly<Record<string, unknown>> = {
  info: { title: "Lohra", version: "0.1.0" },
  paths: {
    "/api/config": {},
    "/api/sessions": {},
    "/api/sessions/{session_id}/messages": {},
    "/api/status": {},
  },
};

const SESSION_MESSAGES_PATTERN = /^\/api\/sessions\/([^/]+)\/messages$/u;
const DOC_ROUTES: ReadonlySet<string> = new Set([
  "/openapi.json",
  "/docs",
  "/redoc",
  "/docs/oauth2-redirect",
]);

function splitPath(rawPath: string): { readonly path: string; readonly query: string } {
  const index = rawPath.indexOf("?");
  return index < 0
    ? { path: rawPath, query: "" }
    : { path: rawPath.slice(0, index), query: rawPath.slice(index) };
}

function underApiPrefix(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function locationFor(head: ParsedRequestHead, targetPath: string): string {
  const host = firstHeaderValue(head.headers, "Host") ?? "";
  return `http://${host}${targetPath}`;
}

function redirectTo(head: ParsedRequestHead, targetPath: string): OutgoingHttpResponse {
  return {
    status: 307,
    statusText: "Temporary Redirect",
    headers: { location: locationFor(head, targetPath), "content-length": "0" },
    body: Buffer.alloc(0),
  };
}

function isTokenAuthorized(head: ParsedRequestHead, context: RouteContext): boolean {
  if (!context.authRequired) return true;
  const presented = firstHeaderValue(head.headers, TOKEN_HEADER);
  if (presented === null) return false;
  return timingSafeTokenEqual(presented, context.expectedToken);
}

// Only the exact (method, path) pairs the baseline measured are given a
// specific verdict here; the contract does not speculate about other
// method/path combinations that were never probed.
function findDocumentedAndAbsent(canonical: string, method: string): "405" | "404" | null {
  for (const route of DOCUMENTED_AND_ABSENT_REST_ROUTES) {
    if (route.path === canonical && route.method === method) {
      return canonical === "/api/config" && method === "PUT" ? "405" : "404";
    }
  }
  return null;
}

// Known real routes under /api, keyed by their canonical (no trailing
// slash) path.
function routeKnownApiPath(
  method: string,
  canonical: string,
  context: RouteContext,
): OutgoingHttpResponse | null {
  if (canonical === "/api/status") {
    // HEAD is not auto-derived from GET on this route -- the oracle
    // measured 405 for HEAD /api/status, not 200 (assertion 16). The route
    // is registered for GET only.
    if (method !== "GET") return METHOD_NOT_ALLOWED;
    return jsonResponse(200, context.handlers.status());
  }
  if (canonical === "/api/sessions") {
    if (method !== "GET") return METHOD_NOT_ALLOWED;
    return jsonResponse(200, context.handlers.sessions());
  }
  if (canonical === "/api/config") {
    if (method !== "GET") return METHOD_NOT_ALLOWED;
    return jsonResponse(200, context.handlers.config());
  }
  const messagesMatch = SESSION_MESSAGES_PATTERN.exec(canonical);
  if (messagesMatch !== null) {
    if (method !== "GET") return METHOD_NOT_ALLOWED;
    return jsonResponse(200, context.handlers.messages(messagesMatch[1] as string));
  }
  return null;
}

function isKnownApiPath(canonical: string): boolean {
  return (
    canonical === "/api/status" ||
    canonical === "/api/sessions" ||
    canonical === "/api/config" ||
    SESSION_MESSAGES_PATTERN.test(canonical)
  );
}

// OPTIONS is exempt from auth (contract decision 4) and only answers
// whether *any* handler exists at this exact path (405) or not (404) --
// a deliberate, unauthenticated enumeration oracle, reproduced rather than
// closed. None of the documented-and-absent routes have a real handler at
// any verb, so only the known/implemented paths (isKnownApiPath) yield 405.
function optionsProbe(canonical: string): OutgoingHttpResponse {
  return isKnownApiPath(canonical) ? METHOD_NOT_ALLOWED : NOT_FOUND;
}

function routeUnderApi(
  method: string,
  head: ParsedRequestHead,
  path: string,
  context: RouteContext,
): OutgoingHttpResponse {
  if (method !== "OPTIONS" && !isTokenAuthorized(head, context)) return UNAUTHORIZED;

  const trailingSlash = path !== "/api" && path.endsWith("/");
  const canonical = trailingSlash ? path.slice(0, -1) : path;

  if (method === "OPTIONS") return optionsProbe(canonical);

  if (trailingSlash && isKnownApiPath(canonical)) return redirectTo(head, canonical);

  const known = routeKnownApiPath(method, canonical, context);
  if (known !== null) return known;

  const documented = findDocumentedAndAbsent(canonical, method);
  if (documented === "405") return METHOD_NOT_ALLOWED;
  return NOT_FOUND;
}

function docRoute(path: string): OutgoingHttpResponse {
  if (path === "/openapi.json") return jsonResponse(200, OPENAPI_DOCUMENT);
  return htmlResponse(200, `<html><body>${path}</body></html>`);
}

function stripBodyForHead(response: OutgoingHttpResponse): OutgoingHttpResponse {
  return {
    ...response,
    headers: { ...response.headers, "content-length": "0" },
    body: Buffer.alloc(0),
  };
}

export function routeGatewayRequest(
  head: ParsedRequestHead,
  context: RouteContext,
): OutgoingHttpResponse {
  const { path } = splitPath(head.path);

  const response = underApiPrefix(path)
    ? routeUnderApi(head.method, head, path, context)
    : DOC_ROUTES.has(path)
      ? docRoute(path)
      : path === "/docs/"
        ? redirectTo(head, "/docs")
        : NOT_FOUND;

  // HEAD never carries a response body, regardless of status -- generic
  // HTTP semantics, not oracle-specific. /api/status HEAD -> 405 (assertion
  // 16) falls out of this for free: HEAD isn't GET, so routeKnownApiPath
  // already answers 405, and this just strips the body.
  return head.method === "HEAD" ? stripBodyForHead(response) : response;
}
