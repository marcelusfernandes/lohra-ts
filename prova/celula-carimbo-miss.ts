// Declaração de prova da issue #461 (M11-S3, épico #458): `cache.missed`
// ganha `reason` (`never_completed` | `identity_changed`) e `cache.replayed`
// ganha `version_state` (`current` | `stale` | `unstamped`) — carimbo
// `identity_version` gravado ao lado da célula (`workflow_node_cache`,
// coluna via `addedColumns`), nunca na chave (decisão 3 do épico, "marca,
// nunca invalida", `docs/decisions/2026-09-10-cache-escopo-irmaos.md`). A
// coluna `node_id` da célula passa a guardar o dono ESCOPADO (`sub1.a`,
// como `nodeCosts` de #348) em vez do id cru — fecha também #475.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-cache-stamp.test.ts",
    "tests/workflow-audit-cache.test.ts",
    "tests/state-workflow-repository.test.ts",
    "tests/workflow-audit-allow-list.test.ts",
  ],
} satisfies Declaracao;
