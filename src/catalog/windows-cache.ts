// Cache em disco de `ProviderModelsValue.windows`, `~/.lohra/model_windows.json`
// (issue #249). Escrita atômica (tmp + rename, via `atomicWrite0600`),
// teto por provedor e por bytes, corrupção vira refetch com aviso — nunca
// crash (invariante 2 do CLAUDE.md: falha nunca silenciosa, fault com
// causa, aqui como `warning` explícito no retorno, não uma exceção
// engolida). Pura o suficiente para testar sem rede: o I/O de disco é
// injetável por `WindowsCacheIO`.
//
// O mesmo caminho (`~/.lohra`) pode já ter um `model_windows.json` escrito
// pelo lohra Python, num formato plano sem versão:
// `{"<provedor>": {"<modelo>": <número>, ...}}`. Esse formato não tem
// `schema_version` — um arquivo sem essa chave (ou com uma versão que este
// runtime não reconhece) é tratado como "formato desconhecido", igual a
// qualquer outra corrupção: os dados de outro programa nunca são lidos
// silenciosamente, o retorno é `{}` com `warning`, e a próxima escrita
// grava por cima no formato novo (envelope versionado).

import { readFileSync } from "node:fs";

import { atomicWrite0600 } from "../auth/json-file.js";

/** Teto de modelos guardados por provedor — não é um limite de exibição. */
export const MAX_MODELS_PER_PROVIDER = 2000;
/** Teto de bytes do arquivo de cache serializado (o envelope inteiro). */
export const MAX_CACHE_BYTES = 8_000_000;
/** Versão do envelope que este runtime escreve e aceita ler. */
export const CACHE_SCHEMA_VERSION = 1;

export type WindowsCache = Readonly<Record<string, Readonly<Record<string, number | null>>>>;

/** Forma persistida em disco — autodescritiva, nunca confundível com o `model_windows.json` do Python. */
export interface WindowsCacheEnvelope {
  readonly schema_version: number;
  readonly updated_at: string;
  readonly providers: WindowsCache;
}

export interface LoadedWindowsCache {
  readonly data: WindowsCache;
  readonly warning: string | null;
}

export interface WindowsCacheIO {
  readonly read: (path: string) => string;
  readonly write: (path: string, data: string) => void;
  readonly now: () => string;
}

export const defaultWindowsCacheIO: WindowsCacheIO = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, data) => {
    atomicWrite0600(path, data);
  },
  now: () => new Date().toISOString(),
};

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isValidWindowValue(value: unknown): value is number | null {
  if (value === null) return true;
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function isValidWindowsShape(value: unknown): value is WindowsCache {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const providerWindows of Object.values(value as Record<string, unknown>)) {
    if (
      typeof providerWindows !== "object" ||
      providerWindows === null ||
      Array.isArray(providerWindows)
    )
      return false;
    for (const window of Object.values(providerWindows as Record<string, unknown>)) {
      if (!isValidWindowValue(window)) return false;
    }
  }
  return true;
}

/**
 * `false` para qualquer coisa que não seja exatamente o envelope deste
 * runtime — inclui o formato plano do lohra Python (sem `schema_version`)
 * e uma versão futura que este runtime ainda não sabe ler.
 */
function isValidEnvelope(value: unknown): value is WindowsCacheEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== CACHE_SCHEMA_VERSION) return false;
  if (typeof record.updated_at !== "string") return false;
  return isValidWindowsShape(record.providers);
}

export function loadWindowsCache(
  path: string,
  io: WindowsCacheIO = defaultWindowsCacheIO,
): LoadedWindowsCache {
  let raw: string;
  try {
    raw = io.read(path);
  } catch (error) {
    if (isEnoent(error)) return { data: {}, warning: null };
    const detail = error instanceof Error ? error.message : String(error);
    return {
      data: {},
      warning: `model window cache unreadable at ${path} (${detail}) — refetching`,
    };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_CACHE_BYTES) {
    return {
      data: {},
      warning: `model window cache at ${path} exceeds ${String(MAX_CACHE_BYTES)} bytes — refetching`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      data: {},
      warning: `model window cache at ${path} is not valid JSON — refetching`,
    };
  }
  if (!isValidEnvelope(parsed)) {
    return {
      data: {},
      warning: `model window cache at ${path} is not in the expected schema_version ${String(CACHE_SCHEMA_VERSION)} envelope (unknown format, maybe written by another program) — refetching`,
    };
  }
  return { data: parsed.providers, warning: null };
}

function capProvider(
  windows: Readonly<Record<string, number | null>>,
): Readonly<Record<string, number | null>> {
  const entries = Object.entries(windows).slice(0, MAX_MODELS_PER_PROVIDER);
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Funde `fresh` (janelas recém-buscadas, por provedor) sobre o que já
 * estava em `previous`, capa cada provedor a `MAX_MODELS_PER_PROVIDER` e
 * escreve atomicamente, dentro do envelope versionado, se o resultado
 * couber em `MAX_CACHE_BYTES`. Nunca lança: erro de escrita (disco cheio,
 * permissão) vira `warning`.
 */
export function saveWindowsCache(
  path: string,
  previous: WindowsCache,
  fresh: WindowsCache,
  io: WindowsCacheIO = defaultWindowsCacheIO,
): string | null {
  const merged: Record<string, Readonly<Record<string, number | null>>> = { ...previous };
  for (const [provider, windows] of Object.entries(fresh)) {
    if (Object.keys(windows).length === 0) continue;
    merged[provider] = capProvider(windows);
  }
  const envelope: WindowsCacheEnvelope = {
    schema_version: CACHE_SCHEMA_VERSION,
    updated_at: io.now(),
    providers: merged,
  };
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CACHE_BYTES) {
    return `model window cache would exceed ${String(MAX_CACHE_BYTES)} bytes — not written`;
  }
  try {
    io.write(path, serialized);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `could not write model window cache at ${path} (${detail})`;
  }
  return null;
}
