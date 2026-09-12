// Issue #459 (M11-S1, épico #458): operator-authorized route fallbacks —
// molde `readTiers` (tiers.ts): fail-closed, same shape of named errors.
// `readRoutes` distinguishes an ABSENT file (legitimate, `{routes: {}}`)
// from one that exists but cannot be trusted; `service.start` refuses the
// launch on the latter, same as `workflow_tiers.json` (#234). `suggestRoute`
// is the pure half — no I/O, no engine access — that picks the first
// fallback a `RouteLesson` hasn't already tried this run.
import { readFileSync } from "node:fs";

export const OPERATOR_ROUTES_FILE = "workflow_routes.json";

/** The two fields a fallback (or the dead route it replaces) always needs —
 * both required, unlike `RouteOverride` (route-override.ts), whose fields
 * are optional and which S2 grows a `channel` on; a fallback the operator
 * authorizes ahead of time always names BOTH. */
export interface Route {
  readonly provider: string;
  readonly model: string;
}

/** `routes["<provider>/<model>"]` is the DEAD route's key; the value is the
 * ORDERED list of fallbacks the operator authorizes for it. */
export interface RouteEnvelope {
  readonly routes: Readonly<Record<string, readonly Route[]>>;
}

const EMPTY_ENVELOPE: RouteEnvelope = Object.freeze({ routes: {} });

/** Named, fail-closed error for a `workflow_routes.json` that exists but
 * cannot be trusted — cites the path and, in `cause`, why (molde `TiersError`). */
export class RoutesError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, cause?: unknown) {
    super(`workflow_routes.json at ${path} is invalid: ${reason}`, { cause });
    this.name = "RoutesError";
    this.path = path;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** Molde `tool.ts`'s own "non-empty after trim" guard (#447) — returns the
 * TRIMMED value, never the raw one: `" anthropic "` used to be accepted
 * as-is and then never matched `suggestRoute`'s exact-string dead-route
 * key (PR #479 rodada 1, non-blocking finding). */
function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
function typeName(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** A route key ("<provider>/<model>") splits on EXACTLY one '/' — zero or
 * more than one is refused (fail-closed, never a best-effort guess at which
 * slash is the separator). `null` for anything else, including an empty
 * provider or model either side of the single slash. */
function splitRouteKey(key: string): Route | null {
  const first = key.indexOf("/");
  if (first < 0 || key.indexOf("/", first + 1) >= 0) return null;
  const provider = key.slice(0, first);
  const model = key.slice(first + 1);
  return provider === "" || model === "" ? null : { provider, model };
}

const FALLBACK_FIELDS = ["provider", "model"] as const;

function parseFallback(
  path: string,
  key: string,
  index: number,
  value: unknown,
): Route | RoutesError {
  const label = `route '${key}[${String(index)}]'`;
  const raw = object(value);
  if (raw === null) {
    return new RoutesError(path, `${label} must be an object, got ${typeName(value)}`);
  }
  for (const field of Object.keys(raw)) {
    if (!(FALLBACK_FIELDS as readonly string[]).includes(field)) {
      return new RoutesError(path, `${label} has an unknown field '${field}'`);
    }
  }
  const provider = nonEmptyText(raw.provider);
  if (provider === undefined) {
    return new RoutesError(path, `${label} is missing a non-empty 'provider'`);
  }
  const model = nonEmptyText(raw.model);
  if (model === undefined) {
    return new RoutesError(path, `${label} is missing a non-empty 'model'`);
  }
  return { provider, model };
}

/**
 * Fail-closed reader for `workflow_routes.json`: an absent file is
 * legitimate (`{routes: {}}` — no fallback authorized for anything yet); a
 * file that exists but cannot be trusted — bad JSON, a non-object root, a
 * top-level key other than `routes`, a route key without exactly one '/', a
 * fallback missing `provider`/`model`, one with an unknown field, one that
 * repeats the dead route itself, or an empty fallback list — is a named
 * `RoutesError` citing the path (and the offending key, where there is one).
 * Every caller (`WorkflowService.start`, this issue's only one) refuses the
 * launch on it, same as `readTiers` (#234).
 */
export function readRoutes(path: string): RouteEnvelope | RoutesError {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    return isEnoent(error) ? EMPTY_ENVELOPE : new RoutesError(path, "could not be read", error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    return new RoutesError(path, "is not valid JSON", error);
  }
  const root = object(parsed);
  if (root === null)
    return new RoutesError(path, `root must be an object, got ${typeName(parsed)}`);
  for (const key of Object.keys(root)) {
    if (key !== "routes") {
      return new RoutesError(path, `unknown top-level key '${key}' (expected 'routes')`);
    }
  }
  if (!("routes" in root)) return EMPTY_ENVELOPE;
  const routesValue = object(root.routes);
  if (routesValue === null) {
    return new RoutesError(path, `'routes' must be an object, got ${typeName(root.routes)}`);
  }
  const routes: Record<string, readonly Route[]> = {};
  for (const key of Object.keys(routesValue)) {
    const dead = splitRouteKey(key);
    if (dead === null) {
      return new RoutesError(
        path,
        `route key '${key}' must have exactly one '/' separating provider and model`,
      );
    }
    const list = routesValue[key];
    if (!Array.isArray(list) || list.length === 0) {
      return new RoutesError(path, `route '${key}' must be a non-empty array of fallbacks`);
    }
    const fallbacks: Route[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const fallback = parseFallback(path, key, index, list[index]);
      if (fallback instanceof RoutesError) return fallback;
      if (fallback.provider === dead.provider && fallback.model === dead.model) {
        return new RoutesError(
          path,
          `route '${key}[${String(index)}]' repeats the dead route itself`,
        );
      }
      fallbacks.push(fallback);
    }
    routes[key] = fallbacks;
  }
  return { routes };
}

/**
 * Pure: the first fallback the envelope authorizes for `lesson`'s dead
 * route (`"<provider>/<model>"`) that isn't already in `tried` — `null`
 * when the lesson names no provider/model, the envelope has no entry for
 * it, or every fallback was already tried this run. Never mutates, never
 * touches the engine or the filesystem.
 */
export function suggestRoute(
  lesson: Readonly<{ provider: string | null; model: string | null }>,
  envelope: RouteEnvelope,
  tried: readonly Readonly<{ provider?: string; model?: string }>[],
): Route | null {
  if (lesson.provider === null || lesson.model === null) return null;
  const fallbacks = envelope.routes[`${lesson.provider}/${lesson.model}`];
  if (fallbacks === undefined) return null;
  for (const candidate of fallbacks) {
    const alreadyTried = tried.some(
      (attempt) => attempt.provider === candidate.provider && attempt.model === candidate.model,
    );
    if (!alreadyTried) return candidate;
  }
  return null;
}
