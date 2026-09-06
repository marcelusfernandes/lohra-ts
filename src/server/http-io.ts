/** Small, framework-free HTTP response/body-reading helpers. No response
 * here ever sets Cache-Control, X-Accel-Buffering, or CORS headers — the
 * oracle doesn't, and inventing any is a contract violation (assertion 35). */

import type { IncomingMessage, ServerResponse } from "node:http";

import { chatCompletionBody } from "./chat-format.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Buffers the full request body as UTF-8. A body over the cap is truncated
 * to the cap length (the request still gets validated/rejected downstream by
 * whatever it fails to parse as — no separate "payload too large" surface is
 * contract-specified). */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** Compact JSON, Content-Type: application/json, explicit Content-Length —
 * never chunked (assertion 35: non-stream has content-length, no
 * transfer-encoding). */
export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const payload = chatCompletionBody(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    ...extraHeaders,
  });
  res.end(payload);
}

export function writeRedirect(res: ServerResponse, host: string | undefined, target: string): void {
  res.writeHead(307, {
    location: `http://${host ?? ""}${target}`,
    "content-length": "0",
  });
  res.end();
}

/** SSE headers only — no Content-Length (Node adds chunked transfer-encoding
 * automatically once the body isn't pre-sized). */
export function startSse(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
}
