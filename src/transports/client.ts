import { assembleStreamedResponse } from "./stream.js";
import {
  ProviderCallFailed,
  anthropicRetryPolicy,
  calculateRetryDelayMs,
  openAiRetryPolicy,
  shouldRetryStatus,
  type RetryPolicy,
} from "./errors.js";
import { jsonStringifyPythonNumbers, pythonJsonLoads } from "../serialization/python-json.js";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ChatCompletionsTransport } from "./chat-completions.js";
import type { AnthropicMessagesTransport } from "./anthropic-messages.js";
import type { ResponsesTransport } from "./responses.js";
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

/** A stream-truncation error carries whatever bytes arrived before the
 * connection reset, so a streaming caller can replay the already-received
 * deltas through its callbacks (contract-t11 assertion 49: "quebra de
 * transporte após delta parcial emite o delta e depois response.failed")
 * instead of discarding them along with the failed read. */
export interface StreamTruncationError extends Error {
  readonly partialBody?: Uint8Array;
}

function hasPartialBody(error: unknown): error is StreamTruncationError & { partialBody: Uint8Array } {
  return error instanceof Error && "partialBody" in error && (error as StreamTruncationError).partialBody !== undefined;
}

/** A chunked response whose connection resets mid-body (not a graceful close
 * after the terminating chunk) surfaces as a bare "aborted"/ECONNRESET from
 * Node's http client — rephrase it so the cause is legible to a caller that
 * only sees `.message` (matches httpx/h11's own wording for the same
 * failure, which downstream parity comparisons key off of). A graceful close
 * with no error event is a separate, non-error path (clean EOF, handled as a
 * partial success by the SSE assembler) and never reaches this function. */
function describeResponseStreamError(
  error: unknown,
  headers: NodeJS.Dict<string | string[]>,
  partialBody?: Uint8Array,
): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  const transferEncoding = headers["transfer-encoding"];
  const chunked =
    typeof transferEncoding === "string"
      ? transferEncoding.includes("chunked")
      : Array.isArray(transferEncoding) && transferEncoding.some((value) => value.includes("chunked"));
  const resetLike =
    (error as NodeJS.ErrnoException).code === "ECONNRESET" || error.message === "aborted";
  if (!chunked || !resetLike) return error;
  const truncationError: StreamTruncationError = new Error(
    "peer closed connection without sending complete message body (incomplete chunked read)",
    { cause: error },
  );
  if (partialBody !== undefined && partialBody.byteLength > 0) {
    Object.assign(truncationError, { partialBody });
  }
  return truncationError;
}

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
          response.on("error", (error: unknown) => {
            reject(describeResponseStreamError(error, response.headers, Buffer.concat(chunks)));
          });
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

/** Abort-aware delay for the retry loop. A retry-after value can honor up
 * to 120s (openai policy); without this listening for `signal`, a caller
 * that aborts mid-wait (e.g. a client disconnect) would hang until the
 * full backoff/retry-after elapsed instead of unwinding immediately. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("ABORTED"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("ABORTED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

function parseSse(
  body: Uint8Array,
  parse: (value: string) => unknown = (value) => JSON.parse(value) as unknown,
): unknown[] {
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
    chunks.push(parse(data));
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
      try {
        response = await this.request(first);
      } catch (error) {
        if (!String(error).includes("stream_options")) throw error;
        response = await this.request({ ...kwargs, stream: true });
      }
    } catch (error) {
      // Assertion 49: a connection reset mid-body still discards the final
      // turn (the caller's error path builds response.failed/an SSE error
      // frame with no output), but whatever complete deltas DID arrive
      // before the break must reach the caller's callbacks first — they
      // are not still sitting in some buffer the caller could read later.
      if (hasPartialBody(error)) {
        try {
          assembleStreamedResponse(parseSse(error.partialBody), callbacks);
        } catch {
          // A dangling/incomplete trailing frame in the partial buffer —
          // whatever DID parse cleanly was already replayed above.
        }
      }
      throw error;
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
      if (attempt < this.maxRetries && shouldRetryStatus(response.status, response.headers, openAiRetryPolicy)) {
        await sleep(calculateRetryDelayMs(attempt, response.headers, openAiRetryPolicy), signal);
        attempt += 1;
        continue;
      }
      throw providerFailure(response);
    }
  }
}

interface ProviderClientOptions<TTransport> {
  readonly baseUrl: string;
  readonly transport: TTransport;
  readonly http?: ChatHttpPort;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRetries?: number;
}

export interface AnthropicMessagesClientOptions extends ProviderClientOptions<AnthropicMessagesTransport> {
  readonly apiKey: string;
}

async function providerPost(
  http: ChatHttpPort,
  request: ChatHttpRequest,
  maxRetries: number,
  policy: RetryPolicy,
): Promise<HttpResponseData> {
  let attempt = 0;
  for (;;) {
    const response = await http.post(request);
    if (response.status >= 200 && response.status < 300) return response;
    if (attempt < maxRetries && shouldRetryStatus(response.status, response.headers, policy)) {
      await sleep(calculateRetryDelayMs(attempt, response.headers, policy), request.signal);
      attempt += 1;
      continue;
    }
    throw providerFailure(response);
  }
}

function anthropicStream(chunks: readonly unknown[]): unknown {
  const content: Record<string, unknown>[] = [];
  const usage: Record<string, unknown> = {};
  let stopReason: unknown = null;
  for (const raw of chunks) {
    const event = record(raw);
    if (event.type === "message_start") Object.assign(usage, record(record(event.message).usage));
    if (event.type === "content_block_start") {
      const index = typeof event.index === "number" ? event.index : content.length;
      content[index] = { ...record(event.content_block) };
    }
    if (event.type === "content_block_delta") {
      const index = typeof event.index === "number" ? event.index : 0;
      const block = content[index] ?? {};
      const delta = record(event.delta);
      const string = (value: unknown): string => (typeof value === "string" ? value : "");
      if (delta.type === "text_delta") block.text = string(block.text) + string(delta.text);
      if (delta.type === "thinking_delta")
        block.thinking = string(block.thinking) + string(delta.thinking);
      if (delta.type === "signature_delta")
        block.signature = string(block.signature) + string(delta.signature);
      if (delta.type === "input_json_delta")
        block.__json = string(block.__json) + string(delta.partial_json);
      content[index] = block;
    }
    if (event.type === "message_delta") {
      const delta = record(event.delta);
      stopReason = delta.stop_reason ?? stopReason;
      Object.assign(usage, record(event.usage));
    }
  }
  for (const block of content) {
    if (typeof block.__json === "string") {
      try {
        block.input = pythonJsonLoads(block.__json);
      } catch {
        block.input = {};
      }
      delete block.__json;
    }
  }
  return { content, stop_reason: stopReason, usage };
}

export class AnthropicMessagesClient {
  private readonly http: ChatHttpPort;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRetries: number;
  private closed = false;

  constructor(private readonly options: AnthropicMessagesClientOptions) {
    this.http = options.http ?? new NativeChatHttpPort();
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? defaultMaxBytes;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async create(kwargs: ChatKwargs, signal?: AbortSignal): Promise<NormalizedResponse> {
    const response = await this.request(kwargs, signal);
    return this.options.transport.normalizeResponse(
      pythonJsonLoads(new TextDecoder().decode(response.body)),
    );
  }

  async stream(kwargs: ChatKwargs, callbacks: StreamCallbacks = {}): Promise<NormalizedResponse> {
    const response = await this.request({ ...kwargs, stream: true });
    const chunks = parseSse(response.body, pythonJsonLoads);
    for (const raw of chunks) {
      const event = record(raw);
      const delta = record(event.delta);
      if (
        event.type === "content_block_delta" &&
        delta.type === "text_delta" &&
        typeof delta.text === "string"
      )
        callbacks.onText?.(delta.text);
    }
    return this.options.transport.normalizeResponse(anthropicStream(chunks));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.http.close?.();
  }

  private async request(body: ChatKwargs, signal?: AbortSignal): Promise<HttpResponseData> {
    if (this.closed) throw new Error("CLIENT_CLOSED");
    if (!this.options.apiKey)
      throw new TypeError(
        '"Could not resolve authentication method. Expected one of api_key, auth_token, or credentials to be set. Or for one of the `X-Api-Key` or `Authorization` headers to be explicitly omitted"',
      );
    return providerPost(
      this.http,
      {
        url: `${this.options.baseUrl.replace(/\/$/u, "")}/v1/messages`,
        headers: {
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
          accept: "application/json",
          "content-type": "application/json",
        },
        body: jsonStringifyPythonNumbers(body),
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxResponseBytes,
        ...(signal === undefined ? {} : { signal }),
      },
      this.maxRetries,
      anthropicRetryPolicy,
    );
  }
}

export interface ResponsesClientOptions extends ProviderClientOptions<ResponsesTransport> {
  readonly token: string;
  readonly accountId?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
}

function responsesStream(chunks: readonly unknown[], callbacks: StreamCallbacks): unknown {
  const done: unknown[] = [];
  let terminal: Record<string, unknown> | null = null;
  for (const raw of chunks) {
    const event = record(raw);
    if (event.type === "response.output_text.delta" && typeof event.delta === "string")
      callbacks.onText?.(event.delta);
    if (event.type === "response.output_item.done") done.push(record(event.item));
    if (event.type === "response.failed") {
      const response = record(event.response);
      const error = record(response.error);
      const code = typeof error.code === "string" ? error.code : undefined;
      const message = typeof error.message === "string" ? error.message : "unknown error";
      throw new ProviderCallFailed(`Responses API failed: ${code ?? ""} ${message}`.trimEnd(), {
        ...(code === undefined ? {} : { code }),
        payload: response,
      });
    }
    if (event.type === "response.completed" || event.type === "response.incomplete")
      terminal = record(event.response);
  }
  const result = { ...(terminal ?? {}) };
  if (!Array.isArray(result.output) || result.output.length === 0) result.output = done;
  return result;
}

export class ResponsesClient {
  private readonly http: ChatHttpPort;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRetries: number;
  private closed = false;

  constructor(private readonly options: ResponsesClientOptions) {
    this.http = options.http ?? new NativeChatHttpPort();
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? defaultMaxBytes;
    this.maxRetries = options.maxRetries ?? 2;
  }

  create(kwargs: ChatKwargs, signal?: AbortSignal): Promise<NormalizedResponse> {
    return this.stream(kwargs, {}, signal);
  }

  async stream(
    kwargs: ChatKwargs,
    callbacks: StreamCallbacks = {},
    signal?: AbortSignal,
  ): Promise<NormalizedResponse> {
    if (this.closed) throw new Error("CLIENT_CLOSED");
    const response = await providerPost(
      this.http,
      {
        url: `${this.options.baseUrl.replace(/\/$/u, "")}/responses`,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          originator: "codex_cli_rs",
          ...(this.options.accountId ? { "ChatGPT-Account-ID": this.options.accountId } : {}),
          ...(this.options.headers ?? {}),
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...kwargs, stream: true }),
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxResponseBytes,
        ...(signal === undefined ? {} : { signal }),
      },
      this.maxRetries,
      openAiRetryPolicy,
    );
    return this.options.transport.normalizeResponse(
      responsesStream(parseSse(response.body), callbacks),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.http.close?.();
  }
}
