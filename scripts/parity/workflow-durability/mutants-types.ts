// Shared shape for the mutation catalog `run-mutations.ts` runs and any
// sibling catalog module it composes (e.g. `mutants-orchestration.ts`,
// issue #112) — kept in its own module, with no other exports, so a
// sibling never has to import `run-mutations.ts` itself: that module's
// top level runs the actual T16 mutation harness (git archive of HEAD,
// nested vitest runs) the instant it's loaded, which a catalog module
// must never trigger just by declaring its mutants.
export interface Edit {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

export interface Focus {
  /** The test file the oracle for this mutant lives in. */
  readonly file: string;
  /** vitest -t pattern naming the exact test that must go red. */
  readonly test: string;
}

export interface Mutant {
  readonly id: string;
  readonly category: string;
  readonly mechanism: string;
  readonly focus: Focus;
  readonly edits: readonly Edit[];
}
