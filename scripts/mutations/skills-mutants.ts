// Catálogo de mutação da fatia `skills` (issue #681, follow-up das QAs de
// 992edb74/c26486b7 e das PRs #675 (#677)/#679 (#678), que mudaram
// `src/skills/store.ts` sem nenhuma fatia de mutação cobrindo o diretório —
// mesmo molde de #636 para `src/doctor/**`). Mecânica A (`harness.ts`), mesmo
// molde de `doctor-mutants.ts`: cada mutante morre por um teste focado já
// existente ou acrescentado em `tests/skills.test.ts`, `tests/skill-export.test.ts`
// ou `tests/skills-builtin-contract.test.ts`.
//
// Estado vermelho (issue #681, `test(red):`): catálogo vazio até o commit
// verde — `tests/mutations-slices.test.ts` importa `skillsMutants` e reprova
// por contagem/`focusFiles` até os 12 mutantes abaixo existirem de verdade.
import type { Mutant } from "./types.js";

export const skillsMutants: readonly Mutant[] = [];
