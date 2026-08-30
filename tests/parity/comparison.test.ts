import { describe, expect, it } from "vitest";

import { compareRuns } from "../../scripts/parity/compare.js";
import type { RunRecord } from "../../scripts/parity/types.js";

function record(stdout: string, stderr = "", tree: RunRecord["tree"] = []): RunRecord {
  return {
    process: {
      exitCode: 0,
      signal: null,
      stdout: Buffer.from(stdout).toString("base64"),
      stderr: Buffer.from(stderr).toString("base64"),
    },
    tree,
    sqlite: {},
    events: {},
  };
}

describe("comparison", () => {
  it("detects a deliberate divergence and reports both values", () => {
    const result = compareRuns(record("lohra 0.0.11\n"), record("lohra 9.9.9\n"), {
      comparisons: [{ class: "byte", field: "process.stdout" }],
      normalizations: [],
      runtimeValues: {
        oracle: { home: "/one/home", profile: "/one/profile" },
        candidate: { home: "/two/home", profile: "/two/profile" },
      },
    });

    expect(result.verdict).toBe("divergent");
    expect(result.differences).toHaveLength(1);
  });

  it("normalizes only the explicitly declared field", () => {
    const result = compareRuns(
      record("/one/home\n", "/one/profile\n"),
      record("/two/home\n", "/two/profile\n"),
      {
        comparisons: [
          { class: "byte", field: "process.stdout" },
          { class: "byte", field: "process.stderr" },
        ],
        normalizations: [
          {
            field: "process.stdout",
            kind: "replace-runtime-path",
            source: "home",
            replacement: "<HOME>",
          },
        ],
        runtimeValues: {
          oracle: { home: "/one/home", profile: "/one/profile" },
          candidate: { home: "/two/home", profile: "/two/profile" },
        },
      },
    );

    expect(result.verdict).toBe("divergent");
    expect(result.differences.map((difference) => difference.field)).toEqual(["process.stderr"]);
  });

  it("does not implicitly hide a different state.db-shm capture", () => {
    const left = record("", "", [
      { path: ".lohra/state.db-shm", type: "file", size: 3, sha256: "aaa" },
    ]);
    const right = record("", "", [
      { path: ".lohra/state.db-shm", type: "file", size: 3, sha256: "bbb" },
    ]);
    const result = compareRuns(left, right, {
      comparisons: [{ class: "schema", field: "tree" }],
      normalizations: [],
      runtimeValues: {
        oracle: { home: "/one/home", profile: "/one/profile" },
        candidate: { home: "/two/home", profile: "/two/profile" },
      },
    });
    expect(result.verdict).toBe("divergent");
    expect(result.differences[0]?.field).toBe("tree");
  });
});
