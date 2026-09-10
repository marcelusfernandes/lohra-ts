// Resolução da janela efetiva de contexto de um modelo, por precedência
// (issue #250). Pura: nenhuma I/O aqui. Quem carrega o cache do catálogo
// (`loadWindowsCache`, issue #249) e quem lê `LOHRA_CONTEXT_WINDOW`
// (`resolveContextWindowOverride`, `src/config/context-window-env.ts`) fica
// por conta de quem chama esta função — ela só recebe os dados já prontos.
//
// Precedência, do mais para o menos específico:
//   1. override  — config explícita (`LOHRA_CONTEXT_WINDOW`, já validada).
//   2. catalog   — cache do catálogo do provedor, por modelo exato.
//   3. table     — `ProviderProfile.modelWindows`, por prefixo mais longo do
//                  id do modelo (um id datado como "gpt-4o-2024-08-06" casa
//                  com a entrada "gpt-4o").
//   4. provider  — `ProviderProfile.defaultContextWindow`, o piso do provedor.
//   5. default   — 200000, quando nada acima resolveu.
//
// `source` é o rastro de qual nível decidiu — nunca um valor "no escuro".

import type { ProviderProfile } from "./types.js";

/** Piso final quando nenhum nível de precedência resolve a janela. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Cache do catálogo por provedor e modelo — a mesma forma de
 * `WindowsCache` (`src/catalog/windows-cache.ts`), duplicada aqui de
 * propósito para `src/providers/` não depender de `src/catalog/` (a
 * dependência hoje só vai na direção contrária). Quem chama passa
 * `loadWindowsCache(...).data` diretamente.
 */
export type ContextWindowCatalog = Readonly<
  Record<string, Readonly<Record<string, number | null>>>
>;

export type ContextWindowSource = "override" | "catalog" | "table" | "provider" | "default";

export interface ContextWindowResolution {
  readonly tokens: number;
  readonly source: ContextWindowSource;
}

export interface ResolveContextWindowInput {
  readonly provider: string;
  readonly model: string;
  /** Override já validado (por exemplo por `resolveContextWindowOverride`); `null`/`undefined` = ausente. */
  readonly override?: number | null | undefined;
  readonly catalog?: ContextWindowCatalog | null | undefined;
  readonly profile: ProviderProfile;
}

function isValidWindow(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

/** Prefixo mais longo de `model` presente em `table` vence — um id datado
 * como "gpt-4o-2024-08-06" casa com a entrada "gpt-4o" e, se "gpt-4o-mini"
 * também estiver na tabela, um id "gpt-4o-mini-2024-07-18" casa com ela em
 * vez de com a entrada mais curta. */
function longestPrefixMatch(
  model: string,
  table: Readonly<Record<string, number>> | undefined,
): number | null {
  if (table === undefined) return null;
  let bestKey = "";
  let bestValue: number | null = null;
  for (const [key, value] of Object.entries(table)) {
    if (model.startsWith(key) && key.length >= bestKey.length) {
      bestKey = key;
      bestValue = value;
    }
  }
  return bestValue;
}

export function resolveContextWindow(input: ResolveContextWindowInput): ContextWindowResolution {
  const { provider, model, override, catalog, profile } = input;

  if (override !== undefined && override !== null) {
    if (!isValidWindow(override)) {
      throw new Error(`CONTEXT_WINDOW_INVALID_OVERRIDE:${String(override)}`);
    }
    return { tokens: override, source: "override" };
  }

  const cached = catalog?.[provider]?.[model];
  if (isValidWindow(cached)) {
    return { tokens: cached, source: "catalog" };
  }

  const tabled = longestPrefixMatch(model, profile.modelWindows);
  if (tabled !== null) {
    return { tokens: tabled, source: "table" };
  }

  if (isValidWindow(profile.defaultContextWindow)) {
    return { tokens: profile.defaultContextWindow, source: "provider" };
  }

  return { tokens: DEFAULT_CONTEXT_WINDOW, source: "default" };
}
