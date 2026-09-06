export interface OutgoingHttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "OK",
  101: "Switching Protocols",
  307: "Temporary Redirect",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
};

export function jsonResponse(status: number, body: unknown): OutgoingHttpResponse {
  const statusText = STATUS_TEXT[status] ?? "";
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  return {
    status,
    statusText,
    headers: { "content-type": "application/json", "content-length": String(encoded.length) },
    body: encoded,
  };
}

export function emptyResponse(
  status: number,
  headers: Readonly<Record<string, string>> = {},
): OutgoingHttpResponse {
  return {
    status,
    statusText: STATUS_TEXT[status] ?? "",
    headers: { ...headers, "content-length": "0" },
    body: Buffer.alloc(0),
  };
}

export function redirectResponse(location: string): OutgoingHttpResponse {
  return {
    status: 307,
    statusText: STATUS_TEXT[307] as string,
    headers: { location, "content-length": "0" },
    body: Buffer.alloc(0),
  };
}

export function serializeHttpResponse(response: OutgoingHttpResponse): Buffer {
  const statusLine = `HTTP/1.1 ${String(response.status)} ${response.statusText}\r\n`;
  const headerLines = Object.entries(response.headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const head = Buffer.from(`${statusLine}${headerLines}\r\n`, "binary");
  return Buffer.concat([head, response.body]);
}
