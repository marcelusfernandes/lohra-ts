import { describe, expect, it } from "vitest";

import { parseScenarioManifest } from "../../scripts/parity/manifest.js";

const validManifest = {
  schemaVersion: 1,
  id: "test-scenario",
  description: "A deterministic scenario",
  argv: ["--version"],
  environment: { allow: [], set: { PATH: "/usr/bin:/bin", NO_COLOR: "1" } },
  fixtures: [],
  runners: {
    oracle: { adapter: "python", executable: "node", prefixArgs: ["--version"] },
    candidate: { adapter: "typescript", executable: "node", prefixArgs: ["--version"] },
  },
  limits: { timeoutMs: 10_000, maxOutputBytes: 1_048_576 },
  capture: { tree: { enabled: true, root: "profile", exclude: [] }, sqlite: [], events: [] },
  comparisons: [
    { class: "byte", field: "process.exitCode" },
    { class: "byte", field: "process.stdout" },
  ],
  expectations: [],
  normalizations: [],
};

describe("scenario manifest", () => {
  it("accepts the versioned v1 contract", () => {
    expect(parseScenarioManifest(validManifest).id).toBe("test-scenario");
  });

  it("rejects unknown fields instead of silently weakening the contract", () => {
    expect(() => parseScenarioManifest({ ...validManifest, normalizeEverything: true })).toThrow(
      /unknown field/i,
    );
  });

  it("rejects a normalizer for a field not declared for comparison", () => {
    expect(() =>
      parseScenarioManifest({
        ...validManifest,
        normalizations: [
          {
            field: "process.stderr",
            kind: "replace-text",
            search: "volatile",
            replacement: "<VALUE>",
          },
        ],
      }),
    ).toThrow(/normalization field.*comparison/i);
  });

  it("rejects fixture paths that escape the isolated profile", () => {
    expect(() =>
      parseScenarioManifest({
        ...validManifest,
        fixtures: [{ root: "profile", path: "../outside", content: "nope", encoding: "utf8" }],
      }),
    ).toThrow(/relative.*profile/i);
  });
});
