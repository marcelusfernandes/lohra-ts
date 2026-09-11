// Issue #246: a leaf's sandbox refusal (fs/egress denial, taint, or a stale
// stretch's wrapper) used to vanish into the `ERROR: ...` string only the
// leaf's own model read — `faults: []`, `status: complete`, invariant 2
// broken. Fault advisory: counted and visible in `faults` and
// `sandbox_refusals` (rollup + workflow_status), never flips `status` alone
// (`deriveStatus` reads only `RunResult.faults`, never the new
// `RunResult.sandboxFaults`/`sandboxRefusals`).
//
// All three AC (leaf refusal → advisory fault + count with status
// unchanged; zero refusals → nothing new; the count survives a resume) are
// pinned in the one new file below — `tests/workflow-executor.test.ts` was
// already ~38 lines from the 800-line `arquivo-grande` ceiling and
// `tests/workflow-service-durability.test.ts` is at its base (2336 lines),
// so new coverage goes in its own file rather than pushing either over
// (emenda do orquestrador em 2026-09-10).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-sandbox-refusals.test.ts"],
} satisfies Declaracao;
