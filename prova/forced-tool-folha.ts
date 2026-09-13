// Issue #578: `forcedTool` era descartado numa fronteira de spread entre
// `ChildSpawnRequest` (workflow/runtime.ts) e `SpawnConfig`
// (orchestration/core.ts) — a folha nunca recebia a tool `StructuredOutput`
// forçada, mesmo quando o motor pedia. A prova cobre as três fronteiras
// fechadas nesta issue: o repasse em `OrchestrationChildRuntime.spawn`
// (AC 1), o `tool_choice` chegando ao `ModelRequest` de cada um dos três
// transportes via `ConversationRuntime.runTurn` (AC 2), e o run completo
// registrando `forcing_fallbacks: 0` quando a folha responde pela tool
// (AC 3/4) — sempre com o `OrchestrationCore`/`createChildRunner` reais,
// nunca só um `FakeRuntime`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-forced-fallback.test.ts",
    "tests/orchestration-child-runner.test.ts",
    "tests/workflow-campos-sem-efeito.test.ts",
    "tests/conversation-runtime-forced-tool.test.ts",
    "tests/conversation-provider-model-tool-choice.test.ts",
  ],
} satisfies Declaracao;
