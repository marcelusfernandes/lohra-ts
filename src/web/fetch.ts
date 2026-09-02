import { peerRefusalCause } from "./connector.js";
import { validatePublicUrl, WebError } from "./safety.js";
import {
  FETCH_LIMITS,
  type ConnectorRequest,
  type ConnectorResponse,
  type FetchStats,
  type Resolver,
} from "./types.js";

export interface FetchDeps {
  readonly resolver: Resolver;
  readonly connector: {
    request(request: ConnectorRequest): Promise<ConnectorResponse>;
  };
  readonly clock?: () => number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly timeoutSeconds?: number;
}

export interface FetchOutcome {
  readonly text: string;
  readonly stats: FetchStats;
}

export function isTextualContentType(contentType: string): boolean {
  if (contentType === "") return true;
  const lowered = contentType.toLowerCase();
  if (lowered.startsWith("text/")) return true;
  return ["json", "xml", "html", "javascript", "csv"].some((token) => lowered.includes(token));
}

function binaryContentCause(contentType: string): string {
  return `content is not text (Content-Type: ${contentType || "unknown"}); web_fetch only reads text pages`;
}

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function charsetOf(contentType: string): string | null {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
}

const UTF16_CHARSETS = new Set(["utf-16le", "utf-16"]);

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = charsetOf(contentType);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (charset === null) return buffer.toString("utf8");
  if (UTF16_CHARSETS.has(charset)) return buffer.toString("utf16le");
  if (charset === "ascii" || charset === "us-ascii") return buffer.toString("latin1");
  return buffer.toString("latin1");
}

interface CappedRead {
  readonly bytes: Uint8Array;
  readonly stats: {
    readonly bufferedBytes: number;
    readonly cancelled: boolean;
    readonly readCalls: number;
  };
}

async function readCapped(response: ConnectorResponse, maxBytes: number): Promise<CappedRead> {
  const chunks: Buffer[] = [];
  let total = 0;
  let readCalls = 0;
  let cancelled = false;
  for (;;) {
    const result = await response.stream.next();
    readCalls += 1;
    if (result.done) break;
    const chunk = result.value;
    const space = maxBytes - total;
    if (space <= 0) {
      cancelled = true;
      await response.stream.cancel();
      break;
    }
    if (chunk.length > space) {
      chunks.push(Buffer.from(chunk.slice(0, space)));
      total = maxBytes;
      cancelled = true;
      await response.stream.cancel();
      break;
    }
    chunks.push(Buffer.from(chunk));
    total += chunk.length;
    if (total >= maxBytes) {
      cancelled = true;
      await response.stream.cancel();
      break;
    }
  }
  const joined = Buffer.concat(chunks);
  return {
    bytes: joined.subarray(0, maxBytes),
    stats: { bufferedBytes: total, cancelled, readCalls },
  };
}

export async function fetchUrl(url: string, deps: FetchDeps): Promise<FetchOutcome> {
  const maxBytes = deps.maxBytes ?? FETCH_LIMITS.maxBytes;
  const maxRedirects = deps.maxRedirects ?? FETCH_LIMITS.maxRedirects;
  const timeoutSeconds = deps.timeoutSeconds ?? FETCH_LIMITS.timeoutSeconds;
  const clock = deps.clock ?? (() => Date.now());
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const validated = await validatePublicUrl(current, { resolver: deps.resolver });
    const deadlineMs = clock() + timeoutSeconds * 1000;
    const request: ConnectorRequest = {
      url: current,
      method: "GET",
      headers: { "user-agent": FETCH_LIMITS.userAgent },
      allowedAddresses: validated.addresses,
      hostname: validated.hostname,
      timeoutSeconds,
      deadlineMs,
    };
    const response = await deps.connector.request(request);
    const refusal = peerRefusalCause(response.peer, validated.addresses);
    if (refusal !== null) {
      await response.stream.cancel();
      throw new WebError(refusal);
    }
    if (isRedirectStatus(response.status)) {
      const location = response.headers["location"];
      await response.stream.cancel();
      if (location === undefined || location === "") {
        throw new WebError("redirect response had no Location header");
      }
      current = new URL(location, current).href;
      continue;
    }
    const contentType = response.headers["content-type"] ?? "";
    if (!isTextualContentType(contentType)) {
      await response.stream.cancel();
      throw new WebError(binaryContentCause(contentType));
    }
    const read = await readCapped(response, maxBytes);
    return {
      text: decodeBody(read.bytes, contentType),
      stats: {
        bufferedBytes: read.stats.bufferedBytes,
        cancelled: read.stats.cancelled,
        readCalls: read.stats.readCalls,
      },
    };
  }
  throw new WebError(`too many redirects (more than ${String(maxRedirects)})`);
}
