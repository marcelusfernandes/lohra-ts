import { describe, expect, it } from "vitest";

import { parseScenarioManifest } from "../../scripts/parity/manifest.js";

const validManifest = {
  schemaVersion: 1,
  id: "test-scenario",
  description: "A deterministic scenario",
  argv: ["--version"],
  environment: { allow: [], set: { PATH: "/usr/bin:/bin", NO_COLOR: "1" } },
  preconditions: [],
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

  it("requires pointer patterns to contain a wildcard and forbids mixing pointer modes", () => {
    expect(() =>
      parseScenarioManifest({
        ...validManifest,
        expectations: [
          {
            side: "both",
            field: "tree",
            value: "x",
            pointerPattern: "/records/0",
          },
        ],
      }),
    ).toThrow(/wildcard/i);
    expect(() =>
      parseScenarioManifest({
        ...validManifest,
        expectations: [
          {
            side: "both",
            field: "tree",
            value: "x",
            pointer: "/records/0",
            pointerPattern: "/records/*",
          },
        ],
      }),
    ).toThrow(/both pointer/i);
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

  it("accepts only a bounded loopback tcp-port-closed precondition", () => {
    expect(
      parseScenarioManifest({
        ...validManifest,
        preconditions: [{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11_434 }],
      }).preconditions,
    ).toEqual([{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11_434 }]);
    expect(() =>
      parseScenarioManifest({
        ...validManifest,
        preconditions: [{ kind: "tcp-port-closed", host: "0.0.0.0", port: 11_434 }],
      }),
    ).toThrow(/loopback/i);
  });

  it("accepts the explicit T02 stub policy and runner cwd", () => {
    const parsed = parseScenarioManifest({
      ...validManifest,
      runners: {
        oracle: { ...validManifest.runners.oracle, cwd: "profile" },
        candidate: { ...validManifest.runners.candidate, cwd: "home" },
      },
      stub: {
        state: "up-with-models",
        fixture: "chat-text",
        requestLog: {
          comparedHeaders: [
            "authorization",
            "accept",
            "content-type",
            "host",
            "x-stainless-retry-count",
          ],
          excludedHeaders: [
            "accept-encoding",
            "connection",
            "content-length",
            "user-agent",
            "x-stainless-lang",
            "x-stainless-package-version",
            "x-stainless-os",
            "x-stainless-arch",
            "x-stainless-runtime",
            "x-stainless-runtime-version",
            "x-stainless-async",
            "x-stainless-read-timeout",
          ],
        },
      },
    });
    expect(parsed.runners.oracle.cwd).toBe("profile");
    expect(parsed.stub?.state).toBe("up-with-models");
  });

  it("rejects a stub header that is neither compared nor excluded", () => {
    expect(() =>
      parseScenarioManifest({
        ...validManifest,
        stub: {
          state: "up-with-models",
          fixture: "chat-text",
          requestLog: {
            comparedHeaders: ["host"],
            excludedHeaders: [],
          },
        },
      }),
    ).toThrow(/header policy/i);
  });
});
