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

export function loadWindowsCache(
  _path: string,
  _io: WindowsCacheIO = defaultWindowsCacheIO,
): LoadedWindowsCache {
  throw new Error("not implemented: loadWindowsCache");
}

/**
 * Funde `fresh` (janelas recém-buscadas, por provedor) sobre o que já
 * estava em `previous`, capa cada provedor a `MAX_MODELS_PER_PROVIDER` e
 * escreve atomicamente se o resultado couber em `MAX_CACHE_BYTES`. Nunca
 * lança: erro de escrita (disco cheio, permissão) vira `warning`.
 */
export function saveWindowsCache(
  _path: string,
  _previous: WindowsCache,
  _fresh: WindowsCache,
  _io: WindowsCacheIO = defaultWindowsCacheIO,
): string | null {
  throw new Error("not implemented: saveWindowsCache");
}
