// Issue #112 — the `qa` follow-up to PR #110's review: `child-runner.ts`'s
// leaf sandbox wiring (`config.wrapDispatch === undefined ? childDispatch :
// config.wrapDispatch(childDispatch)`, #101/#107) had no `mutations:t16`
// entry watching it, so a regression that dropped the wrap survived
// (96/96 killed, none of them here). This module carries that one entry —
// split out of `run-mutations.ts` (contract `arquivo-grande`, #93/#112:
// that file is already over the 800-line limit and may not grow) — and is
// a plain data module: no top-level side effects, safe for
// `tests/orchestration-child-runner-mutation-catalog.test.ts` to import
// directly, unlike `run-mutations.ts` itself.
//
// Issue #129 adds a second entry here, for `src/workflow/service.ts`'s
// SHUTDOWN_SETTLE_TIMEOUT_MS ceiling — not an orchestration mutant, but
// `run-mutations.ts` is the file that is frozen (`arquivo-grande`), and it
// already imports and spreads only `orchestrationMutants`; this is the one
// sibling catalog module wired in without touching that file.
import type { Mutant } from "./mutants-types.js";

const childRunner = "src/orchestration/child-runner.ts";
const childRunnerTests = "tests/orchestration-child-runner.test.ts";
const workflowService = "src/workflow/service.ts";
const workflowShutdownTests = "tests/workflow-shutdown.test.ts";

export const orchestrationMutants: readonly Mutant[] = [
  {
    id: "an/child-runner-bypasses-the-leaf-wrap",
    category: "sandbox",
    mechanism:
      "createChildRunner drops SpawnConfig.wrapDispatch and always uses the unwrapped child allow-list dispatch, so a leaf sandbox wrap (workflow durable leaves, #107) never runs and a denial never reaches the model",
    focus: {
      file: childRunnerTests,
      test: "wraps the child dispatch, so a denying wrap's own text reaches the tool result",
    },
    edits: [
      {
        file: childRunner,
        before:
          "      const dispatch =\n        config.wrapDispatch === undefined ? childDispatch : config.wrapDispatch(childDispatch);",
        after: "      const dispatch = childDispatch;",
      },
    ],
  },
  {
    id: "ao/shutdown-ceiling-collapses-to-zero",
    category: "clock",
    mechanism:
      "collapsing SHUTDOWN_SETTLE_TIMEOUT_MS to 0 makes shutdown() give up on every still-live run instantly instead of waiting up to 5s for it to settle, so a run that would have finished cleanly is cut off and its lease/completion handler race connection.close() instead of winning it",
    focus: {
      file: workflowShutdownTests,
      test: "hits the shutdown ceiling: a live run that never settles fires the timed-out warning",
    },
    edits: [
      {
        file: workflowService,
        before: "export const SHUTDOWN_SETTLE_TIMEOUT_MS = 5_000;",
        after: "export const SHUTDOWN_SETTLE_TIMEOUT_MS = 0;",
      },
    ],
  },
];
