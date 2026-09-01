import { describe, expect, it } from "vitest";

import { compareMediaRows } from "../scripts/parity/media/comparator.js";

describe("media bilateral comparator", () => {
  it("derives match and rejects an unclassified functional difference", () => {
    expect(
      compareMediaRows([{ id: "same", value: { n: 1 } }], [{ id: "same", value: { n: 1 } }]),
    ).toMatchObject([{ id: "same", classification: "match", pass: true }]);
    expect(
      compareMediaRows([{ id: "changed", value: { n: 1 } }], [{ id: "changed", value: { n: 2 } }]),
    ).toMatchObject([
      {
        id: "changed",
        classification: "unclassified",
        pass: false,
        reason: "unclassified functional difference",
      },
    ]);
  });

  it("requires an intentional divergence to satisfy its approved candidate shape", () => {
    const oracle = [{ id: "unsafe", value: { status: "ok", runner_calls: 1 } }];
    const policy = {
      unsafe: {
        classification: "intentional-divergence/privacy" as const,
        candidate: { status: "error", runner_calls: 0 },
      },
    };
    expect(
      compareMediaRows(
        oracle,
        [{ id: "unsafe", value: { status: "error", runner_calls: 0 } }],
        policy,
      ),
    ).toMatchObject([{ classification: "intentional-divergence/privacy", pass: true }]);
    expect(
      compareMediaRows(
        oracle,
        [{ id: "unsafe", value: { status: "ok", runner_calls: 0 } }],
        policy,
      ),
    ).toMatchObject([
      {
        classification: "intentional-divergence/privacy",
        pass: false,
        reason: "candidate does not satisfy the approved divergence shape",
      },
    ]);
  });

  it("fails missing and duplicate rows instead of normalizing them away", () => {
    expect(compareMediaRows([{ id: "only-oracle", value: 1 }], [])).toMatchObject([
      { classification: "unclassified", pass: false, reason: "missing candidate row" },
    ]);
    expect(() =>
      compareMediaRows(
        [
          { id: "duplicate", value: 1 },
          { id: "duplicate", value: 1 },
        ],
        [],
      ),
    ).toThrow("duplicate oracle media row");
  });
});
