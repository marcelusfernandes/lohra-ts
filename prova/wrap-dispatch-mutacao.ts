// Issue #112: mutação sobrevivente do `qa` da PR #110 — remover a aplicação
// de `SpawnConfig.wrapDispatch` em `child-runner.ts:169-170` passava
// silenciosamente por CI. Parte (1) — o teste ponta a ponta via
// `createChildRunner` real provando que a negação do wrap chega ao filho e
// que `baseDispatch` nunca roda — já está em `main` pela PR #115
// (`orchestration-child-runner.test.ts`). Parte (2) — a prova cobre também
// o teste novo que pina, ANTES do `npm run mutations:t16` mais lento, que o
// catálogo de mutação carrega uma entrada mirando essa exata wiring
// (`orchestration-child-runner-mutation-catalog.test.ts`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/orchestration-child-runner.test.ts",
    "tests/orchestration-child-runner-mutation-catalog.test.ts",
  ],
} satisfies Declaracao;
