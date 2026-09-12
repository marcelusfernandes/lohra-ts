export const UNPARSEABLE = Symbol("workflow-json-unparseable");

function parseCandidate(candidate: string): unknown {
  const trimmed = candidate.trim();
  if (trimmed === "NaN") return Number.NaN;
  if (trimmed === "Infinity") return Infinity;
  if (trimmed === "-Infinity") return -Infinity;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return UNPARSEABLE;
  }
}

function balanced(text: string, opener: "{" | "[", closer: "}" | "]"): string | null {
  const start = text.indexOf(opener);
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === opener) depth += 1;
    if (char === closer) depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

/** #459: pulled out of `service.ts` (`loads`, no mutation anchor on it) to
 * make room for the `routesLoader` field inside that file's zero-growth
 * ceiling — `durableFromRow` (service.ts) uses it to parse the three JSON
 * columns a durable run row carries (`pause_payload_json`, `progress_json`,
 * `spec_json`), falling back to `fallback` for an absent/empty/unparseable
 * value rather than throwing. Renamed (not `loads`) so it reads standalone,
 * away from `loadsLenient`'s very different (best-effort, multi-candidate)
 * contract above. */
export function loadsOr(raw: unknown, fallback: unknown): unknown {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fallback;
  }
}

export function loadsLenient(text: string): unknown {
  const candidates: string[] = [text];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/giu;
  for (const match of text.matchAll(fencePattern)) {
    if (match[1] !== undefined) candidates.push(match[1]);
  }
  const object = balanced(text, "{", "}");
  if (object !== null) candidates.push(object);
  const array = balanced(text, "[", "]");
  if (array !== null) candidates.push(array);

  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (parsed !== UNPARSEABLE) return parsed;
  }
  return UNPARSEABLE;
}
