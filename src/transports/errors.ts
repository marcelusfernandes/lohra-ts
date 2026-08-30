const quotaCodes = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "rate_limit_exceeded",
  "usage_limit_reached",
]);

export class RateLimitError extends Error {
  override readonly name = "RateLimitError";
}

export interface ProviderCallFailedOptions {
  readonly cause?: unknown;
  readonly statusCode?: number;
  readonly code?: string;
  readonly retryAfter?: number;
  readonly response?: unknown;
}

export class ProviderCallFailed extends Error {
  override readonly name = "ProviderCallFailed";
  readonly statusCode: number | undefined;
  readonly code: string | undefined;
  readonly retryAfter: number | undefined;
  readonly response: unknown;

  constructor(message: string, options: ProviderCallFailedOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
    this.response = options.response;
  }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function classifyProviderError(error: unknown): "quota_exhausted" | null {
  if (error instanceof RateLimitError) return "quota_exhausted";
  const value = object(error);
  if (value.statusCode === 429 || value.status === 429) return "quota_exhausted";
  return typeof value.code === "string" && quotaCodes.has(value.code) ? "quota_exhausted" : null;
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
  const match = Object.entries(source).find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

export function retryAfterSeconds(error: unknown): number | null {
  const value = object(error);
  const direct = positiveSeconds(value.retryAfter);
  if (direct !== null) return direct;
  return positiveSeconds(headerValue(object(value.response).headers, "retry-after"));
}
