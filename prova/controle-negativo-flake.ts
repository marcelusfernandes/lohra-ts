// Declaração de prova da issue #122: flake intermitente em
// `ci-controle-negativo-integracao.test.ts` só dentro da suíte completa (qa,
// PR #120). Causa: a checagem "sem diretório temporário vazando" comparava
// `readdirSync(tmpdir())` GLOBAL — compartilhado com toda a suíte — em vez de
// um recurso isolado por execução; corrigida com `TMPDIR` sobrescrito no
// subprocesso (`runControleNegativoComEnv`, em `tests/helpers/`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-controle-negativo-integracao.test.ts"],
} satisfies Declaracao;
