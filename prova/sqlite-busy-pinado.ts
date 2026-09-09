// Declaração de prova da issue #235 (busy_timeout pinado por env e
// detecção de BUSY por error.code, não por regex de mensagem).
//
// tests/state-audit-busy.test.ts, não tests/workflow-audit-live.test.ts:
// esse arquivo já tinha 1213 linhas na base (> 800, issue #93), e as
// asserções de isBusyError o levariam a 1268 — `contratos`/`arquivo-grande`
// reprova arquivo que cresce além do limite mesmo que já estivesse acima
// dele (scripts/ci/contratos/lib.ts:147-160). O novo arquivo cabe no glob
// `tests/state-*.test.ts` de Files.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/state-schema.test.ts", "tests/state-audit-busy.test.ts"],
} satisfies Declaracao;
