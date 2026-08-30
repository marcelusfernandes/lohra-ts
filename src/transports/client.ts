import { assembleStreamedResponse } from "./stream.js";
import { ProviderCallFailed } from "./errors.js";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ChatCompletionsTransport } from "./chat-completions.js";
import type {
  ChatHttpPort,
  ChatHttpRequest,
  ChatKwargs,
  HttpResponseData,
  NormalizedResponse,
  StreamCallbacks,
} from "./types.js";

const defaultTimeoutMs = 30_000;
const defaultMaxBytes = 4_000_000;

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += value.byteLength;
    if (size > maxBytes) {
      throw new Error("RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export class NativeChatHttpPort implements ChatHttpPort {
  constructor(private readonly fetcher?: typeof fetch) {}

  async post(request: ChatHttpRequest): Promise<HttpResponseData> {
    if (this.fetcher === undefined) return this.postNative(request);
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort(request.signal?.reason);
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted === true) abort();
    const timeout = setTimeout(() => {
      controller.abort(new Error("REQUEST_TIMEOUT"));
    }, request.timeoutMs);
    try {
      const response = await this.fetcher(request.url, {
        method: "POST",
        headers: { ...request.headers },
        body: request.body,
        signal: controller.signal,
        redirect: "error",
      });
      return {
        status: response.status,
        headers: response.headers,
        body: await readBounded(response, request.maxBytes),
      };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
    }
  }

  private async postNative(request: ChatHttpRequest): Promise<HttpResponseData> {
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`UNSUPPORTED_PROTOCOL:${url.protocol}`);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return await new Promise<HttpResponseData>((resolve, reject) => {
      const child = send(
        url,
        {
          method: "POST",
          headers: { ...request.headers, "content-length": Buffer.byteLength(request.body) },
        },
        (response) => {
          if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
            response.resume();
            reject(new Error("REDIRECT_NOT_ALLOWED"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > request.maxBytes) {
              response.destroy(new Error("RESPONSE_TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (value === undefined) continue;
              headers.set(key, Array.isArray(value) ? value.join(", ") : value);
            }
            resolve({
              status: response.statusCode ?? 0,
              headers,
              body: new Uint8Array(Buffer.concat(chunks)),
            });
          });
        },
      );
      child.setTimeout(request.timeoutMs, () => {
        child.destroy(new Error("REQUEST_TIMEOUT"));
      });
      const abort = (): void => {
        const reason: unknown = request.signal?.reason;
        child.destroy(reason instanceof Error ? reason : new Error("ABORTED"));
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted === true) abort();
      child.once("close", () => {
        request.signal?.removeEventListener("abort", abort);
      });
      child.on("error", reject);
      child.end(request.body);
    });
  }
}

function parseJson(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function providerFailure(response: HttpResponseData): ProviderCallFailed {
  let payload: unknown = null;
  try {
    payload = parseJson(response.body);
  } catch {
    // The status remains the structured cause when an error body is not JSON.
  }
  const error = record(record(payload).error);
  const message =
    typeof error.message === "string" ? error.message : `HTTP ${String(response.status)}`;
  const code = typeof error.code === "string" ? error.code : undefined;
  return new ProviderCallFailed(message, {
    statusCode: response.status,
    ...(code === undefined ? {} : { code }),
    response: { headers: response.headers },
    payload,
  });
}

function parseSse(body: Uint8Array): unknown[] {
  const chunks: unknown[] = [];
  const blocks = new TextDecoder().decode(body).split(/\r?\n\r?\n/u);
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") break;
    chunks.push(JSON.parse(data) as unknown);
  }
  return chunks;
}

export interface ChatCompletionsClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly transport: ChatCompletionsTransport;
  readonly http?: ChatHttpPort;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRetries?: number;
}

export class ChatCompletionsClient {
  private readonly http: ChatHttpPort;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRetries: number;
  private closed = false;

  constructor(private readonly options: ChatCompletionsClientOptions) {
    this.http = options.http ?? new NativeChatHttpPort();
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? defaultMaxBytes;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async create(kwargs: ChatKwargs, signal?: AbortSignal): Promise<NormalizedResponse> {
    const response = await this.request(kwargs, signal);
    return this.options.transport.normalizeResponse(parseJson(response.body));
  }

  async stream(kwargs: ChatKwargs, callbacks: StreamCallbacks = {}): Promise<NormalizedResponse> {
    const first = { ...kwargs, stream: true, stream_options: { include_usage: true } };
    let response: HttpResponseData;
    try {
      response = await this.request(first);
    } catch (error) {
      if (!String(error).includes("stream_options")) throw error;
      response = await this.request({ ...kwargs, stream: true });
    }
    return this.options.transport.normalizeResponse(
      assembleStreamedResponse(parseSse(response.body), callbacks),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.http.close?.();
  }

  private async request(body: ChatKwargs, signal?: AbortSignal): Promise<HttpResponseData> {
    if (this.closed) throw new Error("CLIENT_CLOSED");
    const request: ChatHttpRequest = {
      url: `${this.options.baseUrl.replace(/\/$/u, "")}/chat/completions`,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
        "x-stainless-retry-count": "0",
      },
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxResponseBytes,
      ...(signal === undefined ? {} : { signal }),
    };
    let attempt = 0;
    for (;;) {
      let response: HttpResponseData;
      try {
        response = await this.http.post({
          ...request,
          headers: { ...request.headers, "x-stainless-retry-count": String(attempt) },
        });
      } catch (error) {
        throw error instanceof Error
          ? error
          : new ProviderCallFailed("provider request failed", { cause: error });
      }
      if (response.status >= 200 && response.status < 300) return response;
      if (response.status >= 500 && attempt < this.maxRetries) {
        attempt += 1;
        continue;
      }
      throw providerFailure(response);
    }
  }
}
