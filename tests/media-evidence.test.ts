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

  it("rejects a divergence that failed for the wrong reason", () => {
    const oracle = [{ id: "row", value: { status: "ok", runner_calls: 1 } }];
    const policy = {
      row: {
        classification: "intentional-divergence/bounded" as const,
        candidate: { status: "error", runner_calls: 0 },
        candidateErrorIncludes: ["too large"],
      },
    };
    expect(
      compareMediaRows(
        oracle,
        [
          {
            id: "row",
            value: { status: "error", runner_calls: 0, error: "image data URI is too large" },
          },
        ],
        policy,
      ),
    ).toMatchObject([{ pass: true, reason: null }]);
    expect(
      compareMediaRows(
        oracle,
        [{ id: "row", value: { status: "error", runner_calls: 0, error: "crash before bound" } }],
        policy,
      ),
    ).toMatchObject([
      {
        pass: false,
        reason: "candidate error message does not match the approved divergence reason",
      },
    ]);
  });

  it("rejects a divergence whose oracle side drifted from the approved reason", () => {
    const policy = {
      row: {
        classification: "intentional-divergence/validation" as const,
        candidate: { status: "error", runner_calls: 0 },
        candidateErrorIncludes: ["EACCES"],
        oracleErrorIncludes: ["Errno 13"],
      },
    };
    const candidate = [
      { id: "row", value: { status: "error", runner_calls: 0, error: "EACCES: denied" } },
    ];
    expect(
      compareMediaRows(
        [
          {
            id: "row",
            value: { status: "error", runner_calls: 0, error: "[Errno 13] Permission denied" },
          },
        ],
        candidate,
        policy,
      ),
    ).toMatchObject([{ pass: true }]);
    expect(
      compareMediaRows(
        [
          {
            id: "row",
            value: { status: "error", runner_calls: 0, error: "something else happened" },
          },
        ],
        candidate,
        policy,
      ),
    ).toMatchObject([
      { pass: false, reason: "oracle error message does not match the approved divergence reason" },
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
