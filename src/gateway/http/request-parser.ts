export interface ParsedRequestHead {
  readonly method: string;
  readonly path: string;
  readonly httpVersion: string;
  readonly headers: readonly (readonly [string, string])[];
}

// Node's built-in http parser strips both leading AND trailing optional
// whitespace (OWS) from header values (RFC 7230 §3.2 permits either).
// The oracle runs on h11, which only strips the leading OWS and preserves
// trailing OWS as literal payload — a deliberate byte-exact behavior this
// gateway must reproduce (contract assertion 15). node:http destroys that
// distinction before user code ever sees it, so header parsing is done by
// hand here instead of delegating to node:http.
function stripLeadingOwsOnly(value: string): string {
  let start = 0;
  while (start < value.length && (value[start] === " " || value[start] === "\t")) start += 1;
  return value.slice(start);
}

export function parseHttpRequestHead(buffer: Buffer): ParsedRequestHead {
  const text = buffer.toString("binary");
  const headerEnd = text.indexOf("\r\n\r\n");
  const headSection = headerEnd < 0 ? text : text.slice(0, headerEnd);
  const lines = headSection.split("\r\n").filter((line) => line.length > 0);
  const requestLine = lines[0];
  if (requestLine === undefined) throw new Error("HTTP_REQUEST_LINE_MISSING");
  const parts = requestLine.split(" ");
  const method = parts[0];
  const path = parts[1];
  const versionToken = parts[2];
  if (method === undefined || path === undefined || versionToken === undefined) {
    throw new Error(`HTTP_REQUEST_LINE_MALFORMED:${requestLine}`);
  }
  const versionMatch = /^HTTP\/(\d\.\d)$/.exec(versionToken);
  if (versionMatch === null) throw new Error(`HTTP_VERSION_MALFORMED:${versionToken}`);
  const httpVersion = versionMatch[1] as string;

  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 0) throw new Error(`HTTP_HEADER_MALFORMED:${line}`);
    const name = line.slice(0, separator);
    const rawValue = line.slice(separator + 1);
    headers.push([name, stripLeadingOwsOnly(rawValue)]);
  }

  return { method, path, httpVersion, headers };
}

export function firstHeaderValue(
  headers: readonly (readonly [string, string])[],
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === lower) return value;
  }
  return null;
}

export function lastHeaderValue(
  headers: readonly (readonly [string, string])[],
  name: string,
): string | null {
  const lower = name.toLowerCase();
  let found: string | null = null;
  for (const [headerName, value] of headers) {
    if (headerName.toLowerCase() === lower) found = value;
  }
  return found;
}
