// Cache em disco de `ProviderModelsValue.windows`, `~/.lohra/model_windows.json`
// (issue #249). Escrita atômica (tmp + rename, via `atomicWrite0600`),
// teto por provedor e por bytes, corrupção vira refetch com aviso — nunca
// crash (invariante 2 do CLAUDE.md: falha nunca silenciosa, fault com
// causa, aqui como `warning` explícito no retorno, não uma exceção
// engolida). Pura o suficiente para testar sem rede: o I/O de disco é
// injetável por `WindowsCacheIO`.

import { readFileSync } from "node:fs";

import { atomicWrite0600 } from "../auth/json-file.js";

/** Teto de modelos guardados por provedor — não é um limite de exibição. */
export const MAX_MODELS_PER_PROVIDER = 2000;
/** Teto de bytes do arquivo de cache serializado. */
export const MAX_CACHE_BYTES = 8_000_000;

export type WindowsCache = Readonly<Record<string, Readonly<Record<string, number | null>>>>;

export interface LoadedWindowsCache {
  readonly data: WindowsCache;
  readonly warning: string | null;
}

export interface WindowsCacheIO {
  readonly read: (path: string) => string;
  readonly write: (path: string, data: string) => void;
}

export const defaultWindowsCacheIO: WindowsCacheIO = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, data) => {
    atomicWrite0600(path, data);
  },
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

function isValidShape(value: unknown): value is WindowsCache {
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
  if (!isValidShape(parsed)) {
    return {
      data: {},
      warning: `model window cache at ${path} has an unexpected shape — refetching`,
    };
  }
  return { data: parsed, warning: null };
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
 * escreve atomicamente se o resultado couber em `MAX_CACHE_BYTES`. Nunca
 * lança: erro de escrita (disco cheio, permissão) vira `warning`.
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
  const serialized = JSON.stringify(merged);
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
