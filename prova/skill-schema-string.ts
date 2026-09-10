// Issue #257: `assets/skills/workflow-authoring/SKILL.md:127` descrevia
// `schema` como aceitando só um objeto inline; `resolveInlineSchema`
// (`src/workflow/schema.ts`) também aceita um nome de `schemas`, igual a
// `schema_ref`, desde a PR #253 (Closes #231).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/skill-workflow-authoring.test.ts"],
} satisfies Declaracao;
