// Declaração de prova da issue #128: dois flakes intermitentes sob carga
// pesada da máquina (observados durante as rodadas de AC 2 das PRs #126 e
// #127) e um terceiro, reportado pelo revisor da PR #127 e confirmado por
// reprodução direta neste worktree:
//
// - `tests/media-persistence.test.ts` — o teste do payload de ~2MB
//   comparava a leitura com `toEqual`, cujo comparador profundo percorre o
//   Buffer elemento a elemento; sob carga isso estourava o timeout de 20s.
//   Trocado por `Buffer.prototype.equals` (mesma garantia, tempo linear
//   nativo).
// - `tests/ci-contratos.test.ts` — o único teste da suíte que chama
//   `runDryRun` (subprocesso `tsx` real) duas vezes em série herdava o
//   default do vitest (5_000ms) pensado para uma chamada única; alinhado a
//   30_000, o mesmo orçamento já usado no arquivo para subprocesso real.
//
// `tests/gateway/launch-candidate.test.ts` foi investigado (ver o corpo da
// PR) mas não reproduziu nas rodadas locais deste worktree, e a causa
// identificada por leitura de código (o handshake de sinal de
// `node_modules/tsx/dist/cli.mjs`) exigiria tocar
// `scripts/parity/gateway/launch-candidate.ts`, fora do `## Files` desta
// issue — por isso não está declarado aqui nem foi tocado.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/media-persistence.test.ts", "tests/ci-contratos.test.ts"],
} satisfies Declaracao;
