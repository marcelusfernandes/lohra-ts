// Issue #447 (M14, achado de revisão do #442): `run_workflow`'s `route`
// validation in `tool.ts` only checked type ('provider'/'model' ARE a
// string), never non-emptiness — `route: {provider: ""}` sailed through,
// got persisted onto the run's spec_json (#427's `applyRouteOverrideToSpec`)
// and burned one of the run's 3 pivots on a doomed spawn. The new block in
// `workflow-route-override.test.ts` ("provider/model must be non-empty
// (#447 AC)") checks provider/model empty and whitespace-only are refused
// with a named error BEFORE the run is touched (no write, no pivot spent),
// and that a normal non-empty 'provider' still works (non-regression).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-route-override.test.ts"],
} satisfies Declaracao;
