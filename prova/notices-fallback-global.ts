// Issue #410 (M8-8): `createNoticesSink.warnState` (`src/workflow/notices-sink.ts`)
// no longer drops a STALE_FENCE_WRITE just because THIS process has no
// valid ownership of the run — no lease (`ownership()` returns `null`), or
// a lease another process has since taken over (`NoticesRepository.append`
// refuses the run-scoped write) — it now falls back to writing the SAME
// notice under `scope: "global"` (`kind: stale_fence_write`, message still
// carrying the `run_id`), counted in `stats().fallback_global` instead of
// `stats().dropped`. `dropped` stays reserved for a `global` append that
// itself fails or throws. Also fixes the mapa: three `audit-trail.ts`
// producers («audit sink failed permanently for run», «audit unavailable
// for run», «audit sanitizer failed for run») that fell into `unknown` now
// classify as `audit_sink_failure`.
// `tests/workflow-notices-sink.test.ts` covers: the two existing
// no-ownership cases now falling back to global instead of being dropped; a
// REAL cross-process takeover (`LockRepository.acquireRunLease` from two
// separate `openStateDatabase` connections — process B takes the lease
// after A's expires, A's sink is refused, the notice lands in `global` and
// is read back through B's own connection with the `run_id` in the
// message); and the three new mapa entries.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-notices-sink.test.ts"],
} satisfies Declaracao;
