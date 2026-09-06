import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Issue #112 — the `qa` follow-up to PR #110: `child-runner.ts:169-170`
// (`config.wrapDispatch === undefined ? childDispatch :
// config.wrapDispatch(childDispatch)`) is the ONLY production site that
// applies the leaf sandbox wrap on top of the child allow-list dispatch,
// and until now `scripts/parity/workflow-durability/run-mutations.ts`'s
// catalog had no entry watching it — a regression that silently dropped
// the wrap survived `mutations:t16` (96/96 killed, none of them here).
//
// `run-mutations.ts` pins every mutant's `before` as EXACT source text
// (`replaceExactlyOnce` — the harness itself throws "mutation anchor not
// found"/"is not unique" the instant it runs against drifted source). This
// test asserts that pin ahead of the slower `npm run mutations:t16`: the
// wiring's exact text still occurs exactly once in `child-runner.ts`, and
// the catalog carries that same text as a mutant's pinned anchor. Deleting
// the catalog entry, or letting the wiring drift away from the pinned
// text, fails `npm test` here — not only the mutation harness.
const root = resolve(__dirname, "..");

const childRunnerSource = readFileSync(resolve(root, "src/orchestration/child-runner.ts"), "utf8");
const mutationsCatalogSource = readFileSync(
  resolve(root, "scripts/parity/workflow-durability/run-mutations.ts"),
  "utf8",
);

const WRAP_DISPATCH_ANCHOR =
  "      const dispatch =\n" +
  "        config.wrapDispatch === undefined ? childDispatch : config.wrapDispatch(childDispatch);";

// `run-mutations.ts`'s `Edit.before` is a TS string LITERAL on disk — its
// newline is the two-character escape `\n` (backslash, n), never an actual
// newline byte. Comparing raw file text needs the anchor spelled the same
// way the catalog spells it, not the real newline `childRunnerSource` has.
const WRAP_DISPATCH_ANCHOR_AS_SOURCE_LITERAL = WRAP_DISPATCH_ANCHOR.replaceAll("\n", "\\n");

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("mutations:t16 catalog pins child-runner.ts's wrapDispatch wiring (#112)", () => {
  it("the wrapDispatch ternary occurs exactly once in child-runner.ts", () => {
    expect(occurrences(childRunnerSource, WRAP_DISPATCH_ANCHOR)).toBe(1);
  });

  it("run-mutations.ts carries this exact text as a mutant's pinned `before`", () => {
    expect(mutationsCatalogSource).toContain(WRAP_DISPATCH_ANCHOR_AS_SOURCE_LITERAL);
  });
});
