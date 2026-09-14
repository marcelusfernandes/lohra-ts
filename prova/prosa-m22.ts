// Issue #640 (sub-issue F1 do residual #637, grupo F item 20, M22): corrige
// prosa falsa e citações de arquivo:linha datadas em
// docs/context-compaction.md, docs/system-prompt.md,
// docs/workflow-supervision.md, README.md e
// assets/skills/workflow-authoring/SKILL.md. O único teste que lê um
// arquivo tocado por esta issue é o que pina o teto de linhas e as
// substrings de SKILL.md — os demais arquivos são prosa sem oráculo
// executável (a prova é o `sed -n` antes/depois no test plan da PR).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/builtin-definitions-budget.test.ts"],
} satisfies Declaracao;
