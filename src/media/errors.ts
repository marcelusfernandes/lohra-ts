const DATA_URI = /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const URL_VALUE = /https?:\/\/[^\s"']+/gi;
const BEARER = /Bearer\s+[^\s"']+/gi;
const SECRET = /\b(?:sk|key|token|secret)[-_A-Za-z0-9]{4,}\b/gi;
const MAX_REDACTION_DEPTH = 8;

function scrub(value: string): string {
  return value
    .replace(DATA_URI, "<redacted-data-uri>")
    .replace(URL_VALUE, "<redacted-url>")
    .replace(BEARER, "Bearer <redacted>")
    .replace(SECRET, "<redacted-secret>");
}

export function safeMediaValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrub(value);
  if (value instanceof Error) {
    if (depth >= MAX_REDACTION_DEPTH) return { name: value.name, message: scrub(value.message) };
    const cause = (value as { cause?: unknown }).cause;
    return {
      name: value.name,
      message: scrub(value.message),
      ...(cause === undefined ? {} : { cause: safeMediaValue(cause, depth + 1) }),
    };
  }
  if (depth >= MAX_REDACTION_DEPTH) return "<redacted-depth>";
  if (Array.isArray(value)) return value.map((entry) => safeMediaValue(entry, depth + 1));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        safeMediaValue(entry, depth + 1),
      ]),
    );
  return value;
}

export function safeMediaMessage(error: unknown, prefix?: string): string {
  const name = error instanceof Error ? error.name : "Error";
  const raw = error instanceof Error ? error.message : String(error);
  const label = prefix === undefined ? "" : `${prefix}: `;
  return `${label}${name}: ${scrub(raw)}`;
}
