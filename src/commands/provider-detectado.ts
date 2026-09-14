// Issue #604: `chat`/`dashboard` recusavam TODA invocação sem `--provider`
// fora do modo `subscription` (`runChatBoundary`), sem consultar as chaves
// que `doctor` já reporta como `usable`. Este módulo é a única ponte entre
// as duas decisões: reusa a mesma regra que `doctor` usa para
// `detected_provider` (`src/doctor/providers.ts`, por sua vez extraída de
// `resolveProviderName` em `src/providers/resolve.js` — não uma tabela
// própria) para que "provedor detectado" signifique a mesma coisa nos dois
// comandos.
//
// Só é chamado quando `--provider` está ausente E a rota é `api_key` — a
// precedência de um `--provider` explícito, e o modo `subscription`
// (`docs/decisions/2026-09-13-flags-de-rota-com-assinatura.md`), continuam
// decididos pelos chamadores antes de qualquer chamada a este módulo.

/** `provider` é o nome resolvido quando a detecção deu certo; `detail` só é
 * não-nulo quando a detecção lançou (ex.: `LOHRA_PROVIDER` aponta para um
 * nome desconhecido) — o chamador decide como reportar isso (nunca engolir
 * a exceção em silêncio, invariante 2 do CLAUDE.md). `provider === null &&
 * detail === null` é o caso "nada configurado": cai na fronteira de sempre. */
export interface ChatProviderDetection {
  readonly provider: string | null;
  readonly detail: string | null;
}

export function detectChatProvider(
  _environment: Readonly<Record<string, string | undefined>>,
): ChatProviderDetection {
  throw new Error("not implemented: detectChatProvider");
}
