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

// Issue #539 (follow-up of #512, veredito non_blocking 1 da PR #538):
// `foldNestedCounters` (accounting.ts:385) writes a nested artifact's
// `node_id` as `sub[${reference}]:${node_id}` — NO space, pinned by
// `tests/workflow-artifacts.test.ts:331` — while every FAULT string scope
// prefix is `sub[${reference}]: ` — WITH a space. `recordCrossStretchArtifact
// Collisions` (accounting.ts:254) used to cunhar its fault straight from
// `artifact.node_id`, so a nested artifact's cross-stretch fault carried the
// UNSPACED chain. The base `NESTED_SCOPE_PREFIX_RE` (space-only) parsed that
// as scope `""` — the SAME empty scope a genuinely unscoped top-level fault
// gets — so the two either wrongly collapsed (different files, same scope
// key) or wrongly survived as two texts for the SAME scope+path (one spaced,
// one not). Fixed: the parser accepts both forms and normalizes them to the
// SAME key.
describe("artifact-collision de-dup key normalizes the unspaced sub[ref]: chain (#539)", () => {
  it("an unspaced cross-stretch-shaped fault and a spaced internal-collision fault for the SAME scope+path collapse to one", () => {
    const spaced = "sub[child]: p: artifact path written by 2 leaves: /nested.txt";
    const unspaced = "sub[child]:p: artifact path written by 2 leaves: /nested.txt";
    expect(dedupeArtifactFaultsByPath([spaced, unspaced])).toEqual([spaced]);
    // Order-independent.
    expect(dedupeArtifactFaultsByPath([unspaced, spaced])).toEqual([unspaced]);
  });

  it("an unspaced nested-scoped fault never collapses with a genuinely unscoped top-level fault on the same path", () => {
    const nested = "sub[innerSingle]:leaf: artifact path written by 2 leaves: /shared.txt";
    const topLevel = "p: artifact path written by 2 leaves: /shared.txt";
    expect(dedupeArtifactFaultsByPath([topLevel, nested])).toEqual([topLevel, nested]);
  });

  it("a doubly-nested unspaced chain normalizes to the SAME key as its spaced form", () => {
    const spaced = "sub[a]: sub[b]: n: artifact path written by 2 leaves: /x";
    const unspaced = "sub[a]:sub[b]:n: artifact path written by 2 leaves: /x";
    expect(dedupeArtifactFaultsByPath([spaced, unspaced])).toEqual([spaced]);
  });

  it("two DIFFERENT unspaced sub[ref] scopes on the same path both survive", () => {
    const first = "sub[a]:n: artifact path written by 2 leaves: /x";
    const second = "sub[b]:n: artifact path written by 2 leaves: /x";
    expect(dedupeArtifactFaultsByPath([first, second])).toEqual([first, second]);
  });
});
