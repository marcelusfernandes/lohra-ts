import { CODEX_PROVIDER } from "../../../dist/providers/index.js";

// CODEX_PROVIDER is deliberately NOT in the provider registry — T10's own
// pack-smoke asserts registry.codex === null (tests/providers-t10.test.ts
// pins the same fact for getProviderProfile("openai-codex")), because a
// subscription-only provider isn't something normal provider auto-
// selection should ever pick up. The live-smoke script for the `responses`
// transport must resolve the profile from this exported constant directly
// — the same way the real subscription path (agent/client-pool.ts's
// buildCodex) reaches it — never by name through the registry, which
// returns null for "openai-codex" by design and would make the smoke
// script refuse before ever reading a credential.
export function resolveResponsesProfile() {
  return CODEX_PROVIDER;
}
