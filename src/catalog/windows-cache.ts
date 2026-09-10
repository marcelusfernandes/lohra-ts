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

/** `{}` congelado, reutilizado em todo retorno vazio para nunca alocar um objeto mutável à toa. */
const EMPTY_WINDOWS_CACHE: WindowsCache = Object.freeze({});

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
    // O teto de bytes é checado por `stat`, antes de `read` — nunca lemos o
    // arquivo inteiro para descobrir que ele é grande demais (#264). ENOENT
    // de qualquer um dos dois cai no mesmo caminho silencioso de "sem cache
    // ainda".
    const stats = io.stat(path);
    if (stats.size > MAX_CACHE_BYTES) {
      return {
        data: EMPTY_WINDOWS_CACHE,
        warning: `context window cache at ${path} exceeds ${String(MAX_CACHE_BYTES)} bytes — refetching`,
      };
    }
    raw = io.read(path);
  } catch (error) {
    if (isEnoent(error)) return { data: EMPTY_WINDOWS_CACHE, warning: null };
    const detail = error instanceof Error ? error.message : String(error);
    return {
      data: EMPTY_WINDOWS_CACHE,
      warning: `context window cache unreadable at ${path} (${detail}) — refetching`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      data: EMPTY_WINDOWS_CACHE,
      warning: `context window cache at ${path} is not valid JSON — refetching`,
    };
  }
  if (!isValidEnvelope(parsed)) {
    return {
      data: EMPTY_WINDOWS_CACHE,
      warning: `context window cache at ${path} is not in the expected schema_version ${String(CACHE_SCHEMA_VERSION)} envelope (unknown format — maybe a stray file, not this runtime's cache) — refetching`,
    };
  }
  return capAndFreezeAllProviders(parsed.providers);
}

function capProvider(
  windows: Readonly<Record<string, number | null>>,
): Readonly<Record<string, number | null>> {
  const entries = Object.entries(windows).slice(0, MAX_MODELS_PER_PROVIDER);
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Capa cada provedor a `MAX_MODELS_PER_PROVIDER` e congela o resultado
 * (outer e cada provedor) — usado na leitura, para o mesmo teto que a
 * escrita já aplicava valer nos dois sentidos (#264): um provedor que ficou
 * acima do teto por um arquivo escrito por outra versão, ou editado à mão,
 * não fica preso acima do teto para sempre só porque nunca mais é
 * re-escrito.
 */
function capAndFreezeAllProviders(providers: WindowsCache): LoadedWindowsCache {
  const overCapped: string[] = [];
  const result: Record<string, Readonly<Record<string, number | null>>> = {};
  for (const [provider, windows] of Object.entries(providers)) {
    if (Object.keys(windows).length > MAX_MODELS_PER_PROVIDER) overCapped.push(provider);
    result[provider] = capProvider(windows);
  }
  const warning =
    overCapped.length > 0
      ? `context window cache provider(s) ${overCapped.join(", ")} exceed ${String(MAX_MODELS_PER_PROVIDER)} models — discarding the rest`
      : null;
  return { data: Object.freeze(result), warning };
}

/**
 * Funde as janelas de um provedor por modelo: um valor novo `null` nunca
 * apaga um número já conhecido (fica o número antigo); um valor novo número
 * sempre vence, mesmo sobre um número antigo diferente. Modelos que só
 * existem em `previous` (o provedor não respondeu por eles nesta busca)
 * sobrevivem — a fusão nunca é um replace por provedor (#264). As chaves de
 * `fresh` vêm primeiro no resultado, para que o teto de `capProvider`
 * descarte modelos obsoletos antes dos que acabaram de ser vistos ao vivo.
 */
function mergeProviderWindows(
  previous: Readonly<Record<string, number | null>> | undefined,
  fresh: Readonly<Record<string, number | null>>,
): Record<string, number | null> {
  const previousWindows = previous ?? {};
  const merged: Record<string, number | null> = {};
  for (const [model, freshValue] of Object.entries(fresh)) {
    const previousValue = previousWindows[model];
    merged[model] = freshValue !== null ? freshValue : (previousValue ?? null);
  }
  for (const [model, previousValue] of Object.entries(previousWindows)) {
    if (!(model in merged)) merged[model] = previousValue;
  }
  return merged;
}

/**
 * Funde `fresh` (janelas recém-buscadas, por provedor) sobre o que já
 * estava em `previous` — por modelo dentro de cada provedor, não por
 * provedor inteiro (#264) — capa cada provedor a `MAX_MODELS_PER_PROVIDER`
 * e escreve atomicamente, dentro do envelope versionado, se o resultado
 * couber em `MAX_CACHE_BYTES`. Nunca lança: erro de escrita (disco cheio,
 * permissão) vira `warning`, e `data` continua sendo `previous` — nada foi
 * persistido, então nada mudou.
 */
export function saveWindowsCache(
  path: string,
  previous: WindowsCache,
  fresh: WindowsCache,
  io: WindowsCacheIO = defaultWindowsCacheIO,
): LoadedWindowsCache {
  const merged: Record<string, Readonly<Record<string, number | null>>> = { ...previous };
  for (const [provider, windows] of Object.entries(fresh)) {
    if (Object.keys(windows).length === 0) continue;
    merged[provider] = capProvider(mergeProviderWindows(previous[provider], windows));
  }
  const frozenMerged: WindowsCache = Object.freeze(merged);
  const envelope: WindowsCacheEnvelope = {
    schema_version: CACHE_SCHEMA_VERSION,
    updated_at: io.now(),
    providers: frozenMerged,
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
  return { data: frozenMerged, warning: null };
}
