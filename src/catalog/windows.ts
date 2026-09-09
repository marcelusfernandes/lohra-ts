// Extração da janela de contexto por modelo a partir do payload de
// `/models` de um provedor (issue #249). Pura — nenhuma I/O aqui; quem
// busca o payload é `catalog.ts`, que também é dono da forma do payload
// (array puro ou `{ data: [...] }`) e do `modelIds` que esta função
// substitui.
//
// Prioridade dos campos, o primeiro presente e válido vence por item:
// `context_length` (OpenRouter) -> `max_input_tokens` -> `context_window`
// (outros provedores). Um campo ausente, não numérico, não inteiro,
// `<= 0` ou não finito nunca é inventado: o modelo entra no mapa com
// `null` — o contrato `ProviderModelsValue.windows` é
// `Record<string, number | null>`, nunca omite a chave.

export interface ExtractedModels {
  readonly ids: readonly string[];
  readonly windows: Readonly<Record<string, number | null>>;
}

const WINDOW_FIELDS = ["context_length", "max_input_tokens", "context_window"] as const;

function isValidWindow(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function windowFromItem(item: unknown): number | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  for (const field of WINDOW_FIELDS) {
    const value = record[field];
    if (isValidWindow(value)) return value;
  }
  return null;
}

function idFromItem(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return null;
  const record = item as { readonly id?: unknown; readonly name?: unknown };
  if (typeof record.id === "string") return record.id;
  if (typeof record.name === "string") return record.name;
  return null;
}

function itemsFromPayload(payload: unknown): readonly unknown[] | null {
  if (Array.isArray(payload)) return payload as readonly unknown[];
  if (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { readonly data?: unknown }).data)
  ) {
    return (payload as { readonly data: readonly unknown[] }).data;
  }
  return null;
}

export function extractModels(payload: unknown): ExtractedModels | null {
  const items = itemsFromPayload(payload);
  if (items === null) return null;
  const seen = new Set<string>();
  const ids: string[] = [];
  const windows: Record<string, number | null> = {};
  for (const item of items) {
    const id = idFromItem(item);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    windows[id] = windowFromItem(item);
  }
  return { ids, windows: Object.freeze(windows) };
}
