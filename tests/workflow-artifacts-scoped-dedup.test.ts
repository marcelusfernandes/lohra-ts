// Issue #512 (follow-up of #501, veredito non_blocking 1 da PR #508):
// `collisionPathOf` (accounting.ts) — the parser BOTH `dedupeArtifactFaultsByPath`
// and `foldArtifactFaults` key their de-dup Set on — used to extract ONLY the
// path substring after `COLLISION_FAULT_MARKER`, discarding whatever came
// before it. `foldNestedCounters` prefixes every one of a nested sub-run's
// OWN artifact faults with `sub[${reference}]: ` when folding them into the
// parent's `RunResult` — so a nested sub-workflow's own collision
// (`sub[ref]: n: artifact path written by 2 leaves: /x`) and a completely
// unrelated top-level collision that merely happens to write the SAME
// literal path string (`m: artifact path written by 2 leaves: /x`) reduced
// to the identical de-dup key ("/x"), even though they are two different
// physical files scoped to two different working roots. One of the two
// advisories silently vanished. Fixed: the de-dup key is (scope, path), so
// the two never collapse.
import { describe, expect, it } from "vitest";

import { dedupeArtifactFaultsByPath } from "../src/workflow/accounting.js";

describe("artifact-collision de-dup key is scope-aware, not path-only (#512)", () => {
  it("a nested sub[ref]-scoped collision and a top-level collision on the SAME literal path both survive", () => {
    const nested = "sub[ref]: n: artifact path written by 2 leaves: /x";
    const topLevel = "m: artifact path written by 2 leaves: /x";
    expect(dedupeArtifactFaultsByPath([nested, topLevel])).toEqual([nested, topLevel]);
    // Order-independent — whichever comes first still keeps both.
    expect(dedupeArtifactFaultsByPath([topLevel, nested])).toEqual([topLevel, nested]);
  });

  it("two DIFFERENT sub[ref] scopes colliding on the same literal path both survive", () => {
    const first = "sub[a]: n: artifact path written by 2 leaves: /x";
    const second = "sub[b]: n: artifact path written by 2 leaves: /x";
    expect(dedupeArtifactFaultsByPath([first, second])).toEqual([first, second]);
  });

  it("the SAME sub[ref] scope colliding on the same path twice still dedupes to one", () => {
    const first = "sub[ref]: n: artifact path written by 2 leaves: /x";
    const second = "sub[ref]: m: artifact path written by 2 leaves: /x";
    expect(dedupeArtifactFaultsByPath([first, second])).toEqual([first]);
  });

  it("two top-level (unscoped) faults on the same path still dedupe to one — unchanged from #501", () => {
    const first = "a: artifact path written by 2 leaves: /shared.txt";
    const second = "b: artifact path written by 2 leaves: /shared.txt";
    expect(dedupeArtifactFaultsByPath([first, second])).toEqual([first]);
  });

  it("a non-collision fault (no marker) is always kept, regardless of a sub[ref]-looking prefix", () => {
    const capMessage = "sub[ref]: n: 3 artifact records dropped past the cap";
    expect(dedupeArtifactFaultsByPath([capMessage])).toEqual([capMessage]);
  });
});
