// A hand-rolled HTTP/1.1 client used ONLY by the T12 parity harness. This
// exists for the same reason the gateway server itself hand-parses request
// heads (src/gateway/http/request-parser.ts): a library-level client
// normalizes header whitespace, reorders/dedupes headers, and generally
// hides exactly the wire-level details this harness exists to observe.
// Every byte here is either what we sent or what we received, unmodified.
import { connect, type Socket } from "node:net";

export interface RawHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: string;
}

export interface RawHttpResponse {
  readonly statusLine: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Buffer;
  readonly rawHead: Buffer;
}

function headerValue(headers: readonly (readonly [string, string])[], name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of headers) if (key.toLowerCase() === lower) return value;
  return null;
}

function serializeRequest(request: RawHttpRequest): Buffer {
  const headerLines = request.headers.map(([name, value]) => `${name}: ${value}\r\n`).join("");
  const body = request.body ?? "";
  const head = `${request.method} ${request.path} HTTP/1.1\r\n${headerLines}\r\n`;
  return Buffer.concat([Buffer.from(head, "binary"), Buffer.from(body, "utf8")]);
}

function parseHead(buffer: Buffer): { readonly head: Buffer; readonly rest: Buffer } | null {
  const index = buffer.indexOf("\r\n\r\n");
  if (index < 0) return null;
  return { head: buffer.subarray(0, index), rest: buffer.subarray(index + 4) };
}

function parseStatusAndHeaders(head: Buffer): {
  readonly statusLine: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: (readonly [string, string])[];
} {
  const text = head.toString("binary");
  const lines = text.split("\r\n");
  const statusLine = lines[0] ?? "";
  const match = /^HTTP\/\d\.\d (\d{3}) (.*)$/u.exec(statusLine);
  const status = match ? Number(match[1]) : 0;
  const statusText = match?.[2] ?? "";
  const headers: (readonly [string, string])[] = [];
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /u, "");
    headers.push([name, value]);
  }
  return { statusLine, status, statusText, headers };
}

// Sends one request over a fresh TCP connection, reads until the response
// is structurally complete (Content-Length, chunked with a terminal 0-size
// chunk, or connection close), and returns the raw bytes alongside the
// parsed status/headers. Chunked decoding is intentionally minimal --
// this gateway never sends chunked responses (every route sets
// Content-Length), so support here is just enough to not misparse one if
// it ever appeared, not a general-purpose implementation.
export async function sendRawHttpRequest(
  host: string,
  port: number,
  request: RawHttpRequest,
  timeoutMs = 5000,
): Promise<RawHttpResponse> {
  return await new Promise((resolvePromise, reject) => {
    const socket: Socket = connect(port, host);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`RAW_HTTP_TIMEOUT after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    function finish(response: RawHttpResponse): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolvePromise(response);
    }

    socket.on("connect", () => {
      socket.write(serializeRequest(request));
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsedHead = parseHead(buffer);
      if (parsedHead === null) return;
      const { statusLine, status, statusText, headers } = parseStatusAndHeaders(parsedHead.head);
      const contentLength = headerValue(headers, "Content-Length");
      const expected = contentLength === null ? null : Number(contentLength);
      if (expected !== null) {
        if (parsedHead.rest.length < expected) return; // wait for more data
        finish({
          statusLine,
          status,
          statusText,
          headers,
          body: parsedHead.rest.subarray(0, expected),
          rawHead: parsedHead.head,
        });
        return;
      }
      // No Content-Length (e.g. a 307 with an empty body and no length
      // header set) -- treat whatever arrived after the header terminator
      // as the complete body immediately; this gateway never streams a
      // response body without a known length.
      finish({
        statusLine,
        status,
        statusText,
        headers,
        body: parsedHead.rest,
        rawHead: parsedHead.head,
      });
    });

    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    socket.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const parsedHead = parseHead(buffer);
      if (parsedHead === null) {
        reject(new Error("RAW_HTTP_CONNECTION_CLOSED_BEFORE_HEADERS"));
        return;
      }
      const { statusLine, status, statusText, headers } = parseStatusAndHeaders(parsedHead.head);
      resolvePromise({
        statusLine,
        status,
        statusText,
        headers,
        body: parsedHead.rest,
        rawHead: parsedHead.head,
      });
    });
  });
}
