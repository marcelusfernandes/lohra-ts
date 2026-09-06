import { CODEX_PROVIDER } from "../../../src/providers/index.js";
import type { ProviderProfile } from "../../../src/providers/types.js";

// Gêmeo, consumido só por `tests/parity/responses-profile.test.ts`, de
// `responses-profile.mjs` (issue #2). O `.mjs` importa de `dist/` de
// propósito — `live-smoke.mjs` o usa como parte de um smoke test real do
// pacote COMPILADO, via `node` puro (`npm run parity:t10:live-smoke`), então
// não pode trocar `dist/` por `src/` sem deixar de testar o artefato que de
// fato é publicado. O teste de paridade, ao contrário, só precisa confirmar
// que a resolução do profile do Codex nunca passa pelo lookup por nome do
// registry (`getProviderProfile("openai-codex")`, que devolve `null` de
// propósito — ver o comentário do próprio teste) — e não depende de `dist/`
// existir. Este arquivo importa `src/` diretamente, então roda sob `vitest`
// (que transforma `.ts` em memória) sem exigir `npm run build` antes.
export function resolveResponsesProfile(): ProviderProfile {
  return CODEX_PROVIDER;
}
