// Issue #459 (M11-S1, épico #458): operator-authorized route fallbacks —
// molde `readTiers` (tiers.ts): fail-closed, same shape of named errors.
// Stub — `test(red)` commit; real bodies land in the next (green) commit.
export const OPERATOR_ROUTES_FILE = "workflow_routes.json";

export interface Route {
  readonly provider: string;
  readonly model: string;
}

export interface RouteEnvelope {
  readonly routes: Readonly<Record<string, readonly Route[]>>;
}

export class RoutesError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, cause?: unknown) {
    super(`workflow_routes.json at ${path} is invalid: ${reason}`, { cause });
    this.name = "RoutesError";
    this.path = path;
  }
}

export function readRoutes(path: string): RouteEnvelope | RoutesError {
  void path;
  throw new Error("not implemented: readRoutes");
}

export function suggestRoute(
  lesson: Readonly<{ provider: string | null; model: string | null }>,
  envelope: RouteEnvelope,
  tried: readonly Readonly<{ provider?: string; model?: string }>[],
): Route | null {
  void lesson;
  void envelope;
  void tried;
  throw new Error("not implemented: suggestRoute");
}
