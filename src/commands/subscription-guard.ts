// Issue #440 (chat.ts, PR #455) / #457 (dashboard.ts mirror): in subscription
// mode, an explicit --provider names a route this mode can't take -- the
// account only ever talks to Codex's own Responses transport, so honoring a
// different provider profile either got silently dropped (dashboard, before
// this fix) or produced a stderr note while still routing --model to Codex
// anyway (chat, before #440), both ending in an opaque 400 from the
// provider instead of a clear cause at the boundary.
//
// Shared here so both commands refuse with the exact same message and the
// exact same condition -- doctrine in
// docs/decisions/2026-09-13-flags-de-rota-com-assinatura.md. `--model`
// alone (no --provider) is unaffected by this guard: it is how an operator
// picks the subscription's own model and must keep going to Codex.
export function subscriptionProviderRefusal(provider: string | undefined): string | null {
  if (provider === undefined) return null;
  return (
    `--provider ${provider} cannot be honored while subscription mode is active — ` +
    "run `lohra auth prefer api_key` to use API-key routes, or omit --provider."
  );
}
