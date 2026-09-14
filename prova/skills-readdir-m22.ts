// Issue #678: `collectSkillFiles` nomeia o erro de `readdirSync` (path +
// code) em vez de engolir em silêncio; `docs/system-prompt.md` com o
// intervalo certo do `catch` de `web_search`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/skills.test.ts"],
} satisfies Declaracao;
