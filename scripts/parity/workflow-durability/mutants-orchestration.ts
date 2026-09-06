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
//
// Issue #138 — the `qa` follow-up to PR #133's review (reason 5): two
// manual mutations against `onEvent`'s progress hook (#125, service.ts
// ~:860-866) survived because no test watched the CARDINALITY of the
// intermediate progress write or the `tainted` value AT the instant of
// that write (only the final, terminal-write state). Both entries below
// are scored against `tests/workflow-progress-cobertura.test.ts`.
//
// Issue #143 — the `qa` follow-up to PR #139 (mutation (c)): dropping the
// `workflow: ` prefix `productionWarningSink` (ownership-store.ts:36)
// writes to its default sink left the whole suite green, because every
// existing test injects its own `write` and asserts the structured
// `StateWarning`, never the formatted line. Scored against
// `tests/workflow-durable-roots.test.ts`.
import type { Mutant } from "./mutants-types.js";

const childRunner = "src/orchestration/child-runner.ts";
const childRunnerTests = "tests/orchestration-child-runner.test.ts";
const workflowService = "src/workflow/service.ts";
const workflowShutdownTests = "tests/workflow-shutdown.test.ts";
const workflowProgressCoberturaTests = "tests/workflow-progress-cobertura.test.ts";
const ownershipStore = "src/workflow/ownership-store.ts";
const workflowDurableRootsTests = "tests/workflow-durable-roots.test.ts";

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
  {
    id: "ap/progress-line-predicate-always-fires",
    category: "durable-line",
    mechanism:
      'the onEvent hook\'s guard (event.kind === "node" && event.state !== "running") collapses to always-true, so the intermediate progress write also fires on each node\'s OWN "running" start event — 2N inert writes per run instead of N — and no test reading only the final progress content ever notices',
    focus: {
      file: workflowProgressCoberturaTests,
      test: "persists exactly one intermediate progress write per COMPLETED node, none on start",
    },
    edits: [
      {
        file: workflowService,
        before: '        if (event.kind === "node" && event.state !== "running") {',
        after: '        if (event.kind === "node" && true) {',
      },
    ],
  },
  {
    id: "aq/progress-line-tainted-forced-false-at-write",
    category: "sandbox",
    mechanism:
      "the intermediate progress write's call site forces its own tainted argument to false regardless of tainted || this.taintTracker.tainted, so a run tainted by its first node's leaf persists an untainted intermediate line — invisible to any test that only reads tainted from the terminal write (which uses the unmutated taintedNow) after the whole run settles",
    focus: {
      file: workflowProgressCoberturaTests,
      test: "the intermediate write after a tainted leaf already carries tainted=1, before the terminal write",
    },
    edits: [
      {
        file: workflowService,
        before:
          '          persistLine("running", null, null, tainted || this.taintTracker.tainted, ownership);',
        after: '          persistLine("running", null, null, false, ownership);',
      },
    ],
  },
  {
    id: "ar/sink-drops-the-workflow-prefix",
    category: "durable-line",
    mechanism:
      "productionWarningSink's default write drops the `workflow: ` prefix from the formatted line, so a STALE_FENCE_WRITE refusal is still reported but no longer greppable as `workflow:` — every existing test asserts the structured StateWarning, never the formatted line, so this survived until #143",
    focus: {
      file: workflowDurableRootsTests,
      test: "formats a warning as workflow: <cause> run=<runId> fence=<fence>",
    },
    edits: [
      {
        file: ownershipStore,
        before:
          "    write(`workflow: ${warning.cause} run=${warning.runId} fence=${String(warning.fence)}`);",
        after: "    write(`${warning.cause} run=${warning.runId} fence=${String(warning.fence)}`);",
      },
    ],
  },
];
