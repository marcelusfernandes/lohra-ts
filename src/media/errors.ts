const DATA_URI = /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const URL_VALUE = /https?:\/\/[^\s"']+/gi;
const BEARER = /Bearer\s+[^\s"']+/gi;

export function safeMediaMessage(error: unknown, prefix?: string): string {
  const name = error instanceof Error ? error.name : "Error";
  const raw = error instanceof Error ? error.message : String(error);
  const clean = raw
    .replace(DATA_URI, "<redacted-data-uri>")
    .replace(URL_VALUE, "<redacted-url>")
    .replace(BEARER, "Bearer <redacted>")
    .replace(/\b(?:sk|key|token|secret)[-_A-Za-z0-9]{4,}\b/gi, "<redacted-secret>");
  const label = prefix === undefined ? "" : `${prefix}: `;
  return `${label}${name}: ${clean}`;
}
