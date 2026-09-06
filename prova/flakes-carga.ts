// Declaração de prova da issue #128: dois flakes intermitentes sob carga
// pesada da máquina (observados durante as rodadas de AC 2 das PRs #126 e
// #127), corrigidos nesta branch, e um terceiro reportado pelo revisor da
// PR #127 e reproduzido diretamente neste worktree, mas não corrigido:
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
// - `tests/gateway/launch-candidate.test.ts` — declarado aqui porque a
//   issue #128 e o AC 2 pedem os dois arquivos originais, e uma reprodução
//   real aconteceu durante o AC 2 desta própria branch (`expected 130 to
//   be +0`, 1 falha em 20 execuções completas de `npm test`). NÃO foi
//   corrigido: a causa (o handshake de sinal de tsx, ~30ms+30ms entre o
//   processo wrapper e o processo real, force-SIGKILL + `exit(128+sinal)`
//   quando o ack não chega a tempo — `node_modules/tsx/dist/cli.mjs`,
//   função `relaySignalToChild`) fica inteiramente em `tsx` (dependência),
//   e a correção viável (não passar pelo wrapper `tsx/dist/cli.mjs`, ver o
//   corpo da PR) exigiria editar `scripts/parity/gateway/launch-candidate.ts`,
//   fora do `## Files` desta issue. Ver o corpo da PR para o diagnóstico
//   completo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/media-persistence.test.ts",
    "tests/ci-contratos.test.ts",
    "tests/gateway/launch-candidate.test.ts",
  ],
} satisfies Declaracao;
