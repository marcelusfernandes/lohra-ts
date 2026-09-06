// Issue #112 — the `qa` follow-up to PR #110's review: `child-runner.ts`'s
// leaf sandbox wiring (`config.wrapDispatch === undefined ? childDispatch :
// config.wrapDispatch(childDispatch)`, #101/#107) had no `mutations:t16`
// entry watching it, so a regression that dropped the wrap survived
// (96/96 killed, none of them here). This module will carry that one
// entry — split out of `run-mutations.ts` (contract `arquivo-grande`,
// #93/#112: that file is already over the 800-line limit and may not
// grow) — as a plain data module: no top-level side effects, safe for
// `tests/orchestration-child-runner-mutation-catalog.test.ts` to import
// directly, unlike `run-mutations.ts` itself.
//
// test(red) checkpoint: the entry lands in the next commit. Throwing
// stub (worktree-segura §7) — the missing implementation is a RUNTIME
// red, not a TypeScript error, so the pin test that imports this module
// fails honestly at collection time.
import type { Mutant } from "./mutants-types.js";

export const orchestrationMutants: readonly Mutant[] = (() => {
  throw new Error("not implemented: an/child-runner-bypasses-the-leaf-wrap");
})();
