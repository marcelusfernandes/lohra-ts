// Declaração de prova da issue #307: as cinco esperas de relógio
// (`setTimeout(50)`) restantes em `tests/gateway/dashboard-command.test.ts`
// (apontadas pelos vereditos das PRs #303/#306) trocadas pelo mesmo sinal de
// prontidão de `tests/dashboard-host.test.ts` (`waitUntilBound` +
// `Promise.race([ready, donePromise])`, #302/#303); e a caracterização sob
// carga dupla (dois `npm test` completos em paralelo) de
// `tests/provenance-check.test.ts` e `tests/media-normalization.test.ts`,
// apontados como "novos" pelo revisor da PR #306 com caracterização fraca.
//
// A caracterização real (corpo da PR) não confirmou a causa especulada
// (git temporário + `spawnSync`): `provenance-check.test.ts` ficou 5/5 limpo
// sob carga; `media-normalization.test.ts` capturou, direto no log de um dos
// dois `npm test` de fundo, `Error: Test timed out in 5000ms` no teste
// "covers legal encoded and decoded 20 MiB boundaries" — trabalho síncrono
// de verdade (múltiplas conversões base64 de ~20 MiB) que passou de 5s sob
// contenção de CPU, sem nenhum `spawnSync`/`git` envolvido nesse arquivo.
// Corrigidos: timeout de teste explícito nesse `it()` (20 MiB, mesmo padrão
// já usado no arquivo para o caso de 1 MiB) e `timeout` explícito no
// `spawnSync` de `provenance-check.test.ts` (mais o timeout de teste
// correspondente nos quatro `it()` que o chamam), como proteção mínima
// justificada mesmo sem falha reproduzida nesse arquivo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/gateway/dashboard-command.test.ts",
    "tests/provenance-check.test.ts",
    "tests/media-normalization.test.ts",
  ],
} satisfies Declaracao;
