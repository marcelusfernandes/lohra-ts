import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { orchestrationMutants } from "../scripts/parity/workflow-durability/mutants-orchestration.js";

// Issue #112 — the `qa` follow-up to PR #110: `child-runner.ts:169-170`
// (`config.wrapDispatch === undefined ? childDispatch :
// config.wrapDispatch(childDispatch)`) is the ONLY production site that
// applies the leaf sandbox wrap on top of the child allow-list dispatch,
// and until now `scripts/parity/workflow-durability`'s catalog had no
// entry watching it — a regression that silently dropped the wrap
// survived `mutations:t16` (96/96 killed, none of them here).
//
// `mutants-orchestration.ts` (a plain data module, no top-level side
// effects — unlike `run-mutations.ts` itself, which runs the actual T16
// harness at import time) pins every mutant's `before` as EXACT source
// text (`run-mutations.ts`'s `replaceExactlyOnce` throws "mutation anchor
// not found"/"is not unique" the instant it runs against drifted source).
// This test asserts that pin ahead of the slower `npm run mutations:t16`,
// naming the mutant to fix in each assertion's own title: deleting the
// entry, or letting the wiring drift away from the pinned text, fails
// `npm test` here — not only the mutation harness.
const root = resolve(__dirname, "..");
const childRunnerSource = readFileSync(resolve(root, "src/orchestration/child-runner.ts"), "utf8");

const MUTANT_ID = "an/child-runner-bypasses-the-leaf-wrap";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("mutations:t16 catalog pins child-runner.ts's wrapDispatch wiring (#112)", () => {
  const mutant = orchestrationMutants.find((candidate) => candidate.id === MUTANT_ID);

  it(`mutants-orchestration.ts declares ${MUTANT_ID}`, () => {
    expect(mutant).toBeDefined();
  });

  it(`${MUTANT_ID}'s pinned "before" occurs exactly once, verbatim, in child-runner.ts`, () => {
    const before = mutant?.edits[0]?.before ?? "";
    expect(before.length).toBeGreaterThan(0);
    expect(occurrences(childRunnerSource, before)).toBe(1);
  });
});
