/** Pure route matching — exactly the 8 handlers the oracle exposes (contract
 * v2 assertion 13), plus the router-level trailing-slash class (assertion 14)
 * and a closed-world 404/405 (assertions 23/24/24a). No framework: a route
 * table + a small decision function, so the negative sweep and the slash
 * class are provable without spinning up a real listener. */

export const PRODUCT_PATHS = [
  "/health",
  "/v1/models",
  "/v1/chat/completions",
  "/v1/responses",
] as const;

interface RouteSpec {
  readonly name: string;
  readonly methods: readonly string[];
}

const ROUTES: ReadonlyMap<string, RouteSpec> = new Map([
  ["/health", { name: "health", methods: ["GET"] }],
  ["/v1/models", { name: "models", methods: ["GET"] }],
  ["/v1/chat/completions", { name: "chatCompletions", methods: ["POST"] }],
  ["/v1/responses", { name: "responses", methods: ["POST"] }],
  ["/openapi.json", { name: "openapi", methods: ["GET"] }],
  ["/docs", { name: "docs", methods: ["GET"] }],
  ["/redoc", { name: "redoc", methods: ["GET"] }],
  ["/docs/oauth2-redirect", { name: "oauthRedirect", methods: ["GET"] }],
]);

export type RouteMatch =
  | { readonly kind: "route"; readonly name: string; readonly methods: readonly string[] }
  | { readonly kind: "method-not-allowed"; readonly allow: string }
  | { readonly kind: "redirect"; readonly target: string }
  | { readonly kind: "not-found" };

export function matchRoute(method: string, pathname: string): RouteMatch {
  if (pathname !== "/" && pathname.endsWith("/")) {
    const withoutSlash = pathname.slice(0, -1);
    if (ROUTES.has(withoutSlash)) return { kind: "redirect", target: withoutSlash };
  }

  const spec = ROUTES.get(pathname);
  if (spec === undefined) return { kind: "not-found" };
  if (!spec.methods.includes(method))
    return { kind: "method-not-allowed", allow: spec.methods.join(", ") };
  return { kind: "route", name: spec.name, methods: spec.methods };
}
