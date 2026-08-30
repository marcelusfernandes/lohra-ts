import { probeOllamaDown } from "../doctor/snapshot.js";
import { getProviderProfile, listProviders, resolveApiKey } from "../providers/index.js";
import type { ProviderProfile } from "../providers/types.js";
import { Catalog, ProviderModels } from "./types.js";

export const MAX_RESPONSE_BYTES = 4_000_000;
export const DEFAULT_TIMEOUT_MS = 3000;
export const MAX_CONCURRENT_FETCHES = 8;
const subscriptionProvider = "openai-codex";

export interface CatalogResponse {
  readonly status: number;
  readonly body: Uint8Array;
}
export interface CatalogHttpClient {
  get(
    url: string,
    options: {
      readonly headers: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
      readonly maxBytes: number;
    },
  ): Promise<CatalogResponse>;
}
interface BodyReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

export const defaultCatalogClient: CatalogHttpClient = {
  async get(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs);
    try {
      const response = await fetch(url, { headers: options.headers, signal: controller.signal });
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes)
        throw new Error("RESPONSE_TOO_LARGE");
      if (response.body === null) return { status: response.status, body: new Uint8Array() };
      const reader = response.body.getReader() as unknown as BodyReader;
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          const value = result.value;
          if (value === undefined) continue;
          length += value.byteLength;
          if (length > options.maxBytes) {
            await reader.cancel();
            throw new Error("RESPONSE_TOO_LARGE");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  },
};

export function modelsEndpoint(profile: ProviderProfile): string {
  const base = profile.baseUrl.replace(/\/$/, "");
  return profile.apiMode === "anthropic_messages"
    ? `${base}/v1/models?limit=1000`
    : `${base}/models`;
}
export function authHeaders(
  profile: ProviderProfile,
  key: string,
): Readonly<Record<string, string>> {
  if (!key) return { "Accept-Encoding": "identity" };
  if (profile.name === "anthropic")
    return { "x-api-key": key, "anthropic-version": "2023-06-01", "Accept-Encoding": "identity" };
  return { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" };
}

function modelIds(payload: unknown): readonly string[] | null {
  const source = Array.isArray(payload)
    ? payload
    : typeof payload === "object" &&
        payload !== null &&
        Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
  if (source === null) return null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of source) {
    const value =
      typeof item === "string"
        ? item
        : typeof item === "object" && item !== null
          ? typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : typeof (item as { name?: unknown }).name === "string"
              ? (item as { name: string }).name
              : null
          : null;
    if (value !== null && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export async function fetchModels(
  profile: ProviderProfile,
  key: string,
  client: CatalogHttpClient,
): Promise<ProviderModels> {
  try {
    const response = await client.get(modelsEndpoint(profile), {
      headers: authHeaders(profile, key),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    if (response.body.byteLength > MAX_RESPONSE_BYTES)
      return new ProviderModels(
        profile.name,
        "error",
        [],
        0,
        `response too large (> ${String(MAX_RESPONSE_BYTES)} B)`,
      );
    if (response.status !== 200)
      return new ProviderModels(profile.name, "error", [], 0, `HTTP ${String(response.status)}`);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(response.body)) as unknown;
    } catch {
      return new ProviderModels(profile.name, "error", [], 0, "JSONDecodeError");
    }
    const ids = modelIds(payload);
    if (ids === null)
      return new ProviderModels(profile.name, "error", [], 0, "unexpected response shape");
    if (ids.length === 0)
      return new ProviderModels(profile.name, "live", [], 0, "reachable, no models listed");
    const hasMore =
      typeof payload === "object" &&
      payload !== null &&
      (payload as { has_more?: unknown }).has_more === true;
    return new ProviderModels(
      profile.name,
      "live",
      ids,
      ids.length,
      hasMore ? `first page only (${String(ids.length)} ids) — the provider has more` : "",
    );
  } catch (error) {
    const detail =
      error instanceof Error && error.message === "RESPONSE_TOO_LARGE"
        ? `response too large (> ${String(MAX_RESPONSE_BYTES)} B)`
        : error instanceof Error
          ? error.name
          : "Error";
    return new ProviderModels(profile.name, "error", [], 0, detail);
  }
}

function skipped(profile: ProviderProfile): ProviderModels {
  return new ProviderModels(
    profile.name,
    "skipped",
    [],
    0,
    `no API key — set ${profile.envVars.join(" or ")}`,
  );
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  map: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const value = values[index];
      if (value === undefined) return;
      output[index] = await map(value);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function buildCatalog(
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly providers?: readonly string[] | undefined;
    readonly client?: CatalogHttpClient;
    readonly probeOllama?: typeof probeOllamaDown;
    readonly subscriptionActive?: boolean;
  } = {},
): Promise<Catalog> {
  const environment = options.environment ?? {};
  if (options.providers?.map((p) => p.toLowerCase()).includes(subscriptionProvider))
    return new Catalog([
      new ProviderModels(
        subscriptionProvider,
        "skipped",
        [],
        0,
        "subscription mode is off — run `lohra auth enable` (opt-in) and `lohra auth login`",
      ),
    ]);
  const selected =
    options.providers === undefined
      ? listProviders()
      : options.providers
          .map((name) => getProviderProfile(name))
          .filter((p): p is ProviderProfile => p !== null);
  const entries = await mapConcurrent(
    selected,
    MAX_CONCURRENT_FETCHES,
    async (profile): Promise<ProviderModels> => {
      if (profile.name === "ollama") {
        const status = await (options.probeOllama ?? probeOllamaDown)();
        return status.alive
          ? new ProviderModels(
              "ollama",
            "live",
              status.models,
              status.models.length,
              status.models.length === 0 ? "reachable, no models listed" : "",
            )
          : new ProviderModels("ollama", "error", [], 0, status.detail);
      }
      const key = resolveApiKey(profile.name, environment);
      if (key === null && profile.requiresApiKey) return skipped(profile);
      return await fetchModels(profile, key ?? "", options.client ?? defaultCatalogClient);
    },
  );
  return new Catalog(entries);
}
