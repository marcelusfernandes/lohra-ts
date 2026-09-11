// Issue #342: `gate.body`/`loop_until_dry.body` validate the same
// agent-shaped fields `pipeline.stages[*]` does (`tool_less`, `timeout`,
// `retries`, `max_iterations`), but `runGate`/`runLoop` (`engine.ts`) spawned
// every leaf with the OUTER node, never `body` — so a validated knob one
// level down had no reader. `tests/workflow-campos-sem-efeito.test.ts` proves
// each knob now reaches the leaf request (or the retry loop) it names, and
// that the gate/loop cache cell changes with the knob while staying
// byte-identical to the pre-#342 formula when `body` has only `prompt`.
// `tests/workflow-schema.test.ts` covers the sibling fix from the same
// issue: `stages[*].tier` validated against the same enum `validateTier`
// already enforces at the node level.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-campos-sem-efeito.test.ts", "tests/workflow-schema.test.ts"],
} satisfies Declaracao;
