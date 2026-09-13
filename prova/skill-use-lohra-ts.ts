// Issue #590 (épico #575, P14): `use-lohra-ts` substitui a skill exportável
// do Python (`use-lohra`) para este runtime, e as duas skills embutidas
// (`use-lohra-ts`, `workflow-authoring`) ganham gatilho/anti-gatilho na
// description. `tests/skills.test.ts` prova o parser/render de
// `src/skills/store.ts` (inclusive o campo `platforms` removido); o
// contrato novo, `tests/skills-builtin-contract.test.ts`, prova o conteúdo
// das skills em `assets/skills/**` contra `src/cli/arg-spec.ts`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/skills.test.ts", "tests/skills-builtin-contract.test.ts"],
} satisfies Declaracao;
