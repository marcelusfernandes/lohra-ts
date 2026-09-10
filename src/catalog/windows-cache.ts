// Cache em disco de `ProviderModelsValue.windows`, `~/.lohra/context-windows.json`
// (issue #249). Escrita atômica (tmp + rename, via `atomicWrite0600`),
// teto por provedor e por bytes, corrupção vira refetch com aviso — nunca
// crash (invariante 2 do CLAUDE.md: falha nunca silenciosa, fault com
// causa, aqui como `warning` explícito no retorno, não uma exceção
// engolida). Pura o suficiente para testar sem rede: o I/O de disco é
// injetável por `WindowsCacheIO`.
//
// Nome de arquivo próprio, deliberado: o lohra Python guarda o mesmo tipo
// de dado em `~/.lohra/model_windows.json` (formato plano sem versão,
// `{"<provedor>": {"<modelo>": <número>, ...}}`) e `_clean`/`_clean_provider`
// no código dele descartam qualquer coisa que não seja exatamente esse
// formato — inclusive o envelope deste runtime — regravando o arquivo dele
// no formato plano. Se os dois runtimes dividissem o mesmo caminho, cada um
// invalidaria o cache do outro a cada uso (dois programas, dois donos,
// mesmo arquivo). `context-windows.json` evita esse ping-pong; a tolerância
// a formato desconhecido abaixo continua existindo para qualquer outro
// arquivo estranho que apareça nesse caminho (JSON de outra ferramenta, uma
// versão futura deste schema que este runtime ainda não lê), não mais para
// o Python especificamente.

import { readFileSync, statSync } from "node:fs";

import { atomicWrite0600 } from "../auth/json-file.js";

/** Nome do arquivo de cache dentro de `~/.lohra` — próprio deste runtime, nunca `model_windows.json` do lohra Python. */
export const CONTEXT_WINDOWS_FILENAME = "context-windows.json";
/** Teto de modelos guardados por provedor — não é um limite de exibição. */
export const MAX_MODELS_PER_PROVIDER = 2000;
/** Teto de bytes do arquivo de cache serializado (o envelope inteiro). */
export const MAX_CACHE_BYTES = 8_000_000;
/** Versão do envelope que este runtime escreve e aceita ler. */
export const CACHE_SCHEMA_VERSION = 1;

export type WindowsCache = Readonly<Record<string, Readonly<Record<string, number | null>>>>;

/** Forma persistida em disco — autodescritiva, num arquivo próprio (nunca `model_windows.json`, do lohra Python). */
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
  readonly stat: (path: string) => { readonly size: number };
  readonly read: (path: string) => string;
  readonly write: (path: string, data: string) => void;
  readonly now: () => string;
}

export const defaultWindowsCacheIO: WindowsCacheIO = {
  stat: (path) => statSync(path),
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
 * runtime — um arquivo sem `schema_version` (formato plano de outro
 * programa, como o `model_windows.json` do lohra Python, se algum dia
 * aparecesse neste caminho) ou uma versão futura que este runtime ainda
 * não sabe ler.
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
      warning: `context window cache unreadable at ${path} (${detail}) — refetching`,
    };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_CACHE_BYTES) {
    return {
      data: {},
      warning: `context window cache at ${path} exceeds ${String(MAX_CACHE_BYTES)} bytes — refetching`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      data: {},
      warning: `context window cache at ${path} is not valid JSON — refetching`,
    };
  }
  if (!isValidEnvelope(parsed)) {
    return {
      data: {},
      warning: `context window cache at ${path} is not in the expected schema_version ${String(CACHE_SCHEMA_VERSION)} envelope (unknown format — maybe a stray file, not this runtime's cache) — refetching`,
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
): LoadedWindowsCache {
  // TODO(#264): funde por modelo (número novo sempre vence; null novo nunca
  // apaga um número já conhecido). Por ora ainda substitui o provedor
  // inteiro — mantém o vermelho do commit test(red) por comportamento, não
  // por tipo.
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
    return {
      data: previous,
      warning: `context window cache would exceed ${String(MAX_CACHE_BYTES)} bytes — not written`,
    };
  }
  try {
    io.write(path, serialized);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      data: previous,
      warning: `could not write context window cache at ${path} (${detail})`,
    };
  }
  return { data: merged, warning: null };
}
