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

export function extractModels(_payload: unknown): ExtractedModels | null {
  throw new Error("not implemented: extractModels");
}
