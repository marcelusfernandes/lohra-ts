// Declaração de prova da issue #307: as cinco esperas de relógio
// (`setTimeout(50)`) restantes em `tests/gateway/dashboard-command.test.ts`
// (apontadas pelos vereditos das PRs #303/#306) trocadas pelo mesmo sinal de
// prontidão de `tests/dashboard-host.test.ts` (`waitUntilBound` +
// `Promise.race([ready, donePromise])`, #302/#303); e a caracterização sob
// carga dupla (dois `npm test` completos em paralelo) de
// `tests/provenance-check.test.ts` e `tests/media-normalization.test.ts`,
// apontados como "novos" pelo revisor da PR #306 com caracterização fraca.
//
// A caracterização real (corpo da PR #309) não confirmou a causa especulada
// (git temporário + `spawnSync`): `provenance-check.test.ts` ficou 5/5 limpo
// sob carga (ganhou proteção preventiva mesmo assim, já que seu `spawnSync`
// não tinha timeout algum); `media-normalization.test.ts` capturou, direto
// no log dos dois `npm test` de fundo, duas falhas reais em rodadas
// diferentes, nenhuma envolvendo `spawnSync`/`git`:
//   1. `Error: Test timed out in 5000ms` (5119ms observados) em "covers
//      legal encoded and decoded 20 MiB boundaries" — trabalho síncrono de
//      verdade (quatro conversões/validações base64 de ~20 MiB) que passou
//      de 5s sob contenção de CPU. Corrigido com timeout de teste explícito
//      (30s) nesse `it()` — o trabalho é genuíno, sem atalho mais barato.
//   2. `Error: Test timed out in 15000ms` (16626ms observados, mesmo já com
//      um timeout inflado desde antes desta issue) em "absorbs a
//      trusted-root alias and accepts the measured large oracle fixture"
//      (~1 MiB) — mesmo antipadrão já corrigido em
//      `tests/media-persistence.test.ts` (issue #128): `expect(...).toEqual(bytes)`
//      paga o comparador profundo elemento a elemento do vitest num Buffer
//      grande. Corrigido trocando por `Buffer.prototype.equals` (memcmp
//      nativo, O(n)), que remove a causa raiz em vez de só esconder atrás
//      de um timeout maior — o timeout explícito desse teste voltou ao
//      default do vitest depois da correção.
// `provenance-check.test.ts` ganhou `timeout` explícito no `spawnSync` da
// CLI e o timeout de teste correspondente nos quatro `it()` que o chamam.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/gateway/dashboard-command.test.ts",
    "tests/provenance-check.test.ts",
    "tests/media-normalization.test.ts",
  ],
} satisfies Declaracao;
