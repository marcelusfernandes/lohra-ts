import type { ErrorKind } from "./error-kinds.js";

const quotaCodes = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "rate_limit_exceeded",
  "usage_limit_reached",
]);

// Códigos de erro Node (ErrnoException) de falha de conexão — chegam como
// `Error` crua, nunca embrulhados em `ProviderCallFailed`
// (`client.ts` rethrows uma instância de `Error` como está; só um valor
// não-`Error` vira `ProviderCallFailed`). A checagem é estrutural
// (`.code`), igual ao gatilho de quota já existente, não presa a
// `instanceof ProviderCallFailed`.
const networkFaultCodes = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"]);

export class RateLimitError extends Error {
  override readonly name = "RateLimitError";
}

export interface ProviderCallFailedOptions {
  readonly cause?: unknown;
  readonly statusCode?: number;
  readonly code?: string;
  readonly retryAfter?: number;
  readonly response?: unknown;
  readonly payload?: unknown;
}

export class ProviderCallFailed extends Error {
  override readonly name = "ProviderCallFailed";
  readonly statusCode: number | undefined;
  readonly code: string | undefined;
  readonly retryAfter: number | undefined;
  readonly response: unknown;
  readonly payload: unknown;

  constructor(message: string, options: ProviderCallFailedOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
    this.response = options.response;
    this.payload = options.payload;
  }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** `code`/`payload.error.code`/`payload.error.type`/mensagem citam "model"
 * — o indício de modelo que separa um 404 de rota genérico
 * (`model_not_found` da issue #397) de qualquer outro 404. Estrutural,
 * igual ao resto do classificador — não depende do shape exato de nenhum
 * provedor específico. */
function looksLikeModelNotFound(value: Readonly<Record<string, unknown>>): boolean {
  if (typeof value.code === "string" && /model/iu.test(value.code)) return true;
  const payloadError = object(object(value.payload).error);
  if (typeof payloadError.code === "string" && /model/iu.test(payloadError.code)) return true;
  if (typeof payloadError.type === "string" && /model/iu.test(payloadError.type)) return true;
  return typeof value.message === "string" && /model/iu.test(value.message);
}

export function classifyProviderError(error: unknown): ErrorKind | null {
  if (error instanceof RateLimitError) return "quota_exhausted";
  const value = object(error);
  if (value.statusCode === 429 || value.status === 429) return "quota_exhausted";
  if (typeof value.code === "string" && quotaCodes.has(value.code)) return "quota_exhausted";
  if (value.statusCode === 401 || value.statusCode === 403) return "auth_failed";
  if (value.statusCode === 404 && looksLikeModelNotFound(value)) return "model_not_found";
  if (typeof value.code === "string" && networkFaultCodes.has(value.code)) return "route_fault";
  if (typeof value.statusCode === "number" && value.statusCode >= 500 && value.statusCode < 600)
    return "route_fault";
  // Qualquer outro ProviderCallFailed é um erro de provedor sem
  // mapeamento fino — nomeado como "unknown", nunca engolido como `null`
  // (invariante 2, issue #397). Um erro que não é de provedor (não
  // embrulhado em ProviderCallFailed) continua null: o resto da cadeia
  // (child-runner.ts) já trata `null` como "não é uma falha de provedor".
  if (error instanceof ProviderCallFailed) return "unknown";
  return null;
}

function positiveSeconds(value: unknown): number | null {
  if (typeof value === "boolean" || (typeof value !== "number" && typeof value !== "string"))
    return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function headerValue(headers: unknown, name: string): unknown {
  if (headers instanceof Headers) return headers.get(name);
  const source = object(headers);
  return source[name];
}

export function retryAfterSeconds(error: unknown): number | null {
  const value = object(error);
  const direct = positiveSeconds(value.retryAfter);
  if (direct !== null) return direct;
  return positiveSeconds(headerValue(object(value.response).headers, "retry-after"));
}

/** Whether an exceeded Retry-After disarms the retry outright (rather than
 * just being un-honorable and falling back to backoff), and the seconds
 * threshold above which that applies. The two provider SDKs the oracle
 * delegates to genuinely diverge here — [fio] measured directly against
 * both real installed SDKs (openai 3.6.0, anthropic 1.2.0) via a local HTTP
 * stub returning 429 with a far-future Retry-After date: the openai SDK
 * makes exactly 1 request (disarms), the anthropic SDK still makes 3
 * (retries via backoff, only the *honoring* of the literal value is capped
 * at 60s). Neither Lohra client wrapper (OpenAIClient, AnthropicClient,
 * ResponsesClient in agent/client.py) overrides retry behavior, so this is
 * the SDK default in both cases, not Lohra-authored policy. */
export interface RetryPolicy {
  readonly maxRetryAfterSeconds: number;
  readonly disarmWhenRetryAfterExceedsMax: boolean;
}

// openai Python SDK default (_base_client.py: MAX_RETRY_AFTER_DELAY = 120,
// _should_retry disarms when a parsed Retry-After exceeds it). Used by the
// oracle's OpenAIClient and ResponsesClient — both wrap openai.OpenAI.
export const openAiRetryPolicy: RetryPolicy = {
  maxRetryAfterSeconds: 120,
  disarmWhenRetryAfterExceedsMax: true,
};

// anthropic Python SDK default (_base_client.py: _calculate_retry_timeout
// caps honoring at 60s, but _should_retry never consults Retry-After at
// all — eligibility is status-code-only). Used by the oracle's
// AnthropicClient, which wraps anthropic.Anthropic.
export const anthropicRetryPolicy: RetryPolicy = {
  maxRetryAfterSeconds: 60,
  disarmWhenRetryAfterExceedsMax: false,
};

const initialRetryDelayMs = 500;
const maxRetryDelayMs = 8_000;

/** Mirrors both SDKs' `_parse_retry_after_header`: retry-after-ms (float
 * ms) first, then retry-after as float seconds, then retry-after as an
 * HTTP-date. Returns null when none parse — [fio] measured: a genuinely
 * unparseable value (e.g. "banana") does NOT disarm retry on either SDK,
 * it simply falls through to status-code eligibility + backoff timing,
 * same as no header at all. Real HTTP responses always carry a native
 * Headers instance here (Fetch API, case-insensitive .get() by spec), so
 * this never needs the case-sensitivity handling errors.ts's headerValue()
 * applies for constructed/mocked error objects. */
function parseRetryAfterHeader(headers: Headers): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  const seconds = headers.get("retry-after");
  if (seconds === null) return null;
  const asNumber = Number(seconds);
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(seconds);
  return Number.isFinite(asDate) ? (asDate - Date.now()) / 1000 : null;
}

/** Mirrors both SDKs' `_should_retry`: an explicit `x-should-retry`
 * override wins outright; otherwise (for policies that disarm) a
 * Retry-After that parses but exceeds the policy's cap refuses retry
 * entirely; otherwise eligibility is status-code-only (408, 409, 429, or
 * any 5xx) — connection/exception-level failures are deliberately out of
 * scope here and remain non-retried, matching T11's pinned midbreak
 * fixture. */
export function shouldRetryStatus(status: number, headers: Headers, policy: RetryPolicy): boolean {
  const override = headers.get("x-should-retry");
  if (override === "true") return true;
  if (override === "false") return false;
  if (policy.disarmWhenRetryAfterExceedsMax) {
    const retryAfter = parseRetryAfterHeader(headers);
    if (retryAfter !== null && retryAfter > policy.maxRetryAfterSeconds) return false;
  }
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Mirrors both SDKs' `_calculate_retry_timeout`: a Retry-After that
 * parses to a positive value within the policy's cap is honored literally
 * (in ms); otherwise falls back to jittered exponential backoff
 * (500ms * 2^attempt, capped at 8s, jitter in (0.75, 1]). `attempt` is the
 * count of retries already completed (0 for the first retry), matching
 * the SDKs' `nb_retries`. */
export function calculateRetryDelayMs(
  attempt: number,
  headers: Headers,
  policy: RetryPolicy,
): number {
  const retryAfter = parseRetryAfterHeader(headers);
  if (retryAfter !== null && retryAfter > 0 && retryAfter <= policy.maxRetryAfterSeconds)
    return retryAfter * 1000;
  const backoff = Math.min(initialRetryDelayMs * 2 ** attempt, maxRetryDelayMs);
  const jitter = 1 - 0.25 * Math.random();
  const timeout = backoff * jitter;
  return timeout >= 0 ? timeout : 0;
}
