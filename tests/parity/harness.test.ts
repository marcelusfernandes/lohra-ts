import process from "node:process";

import { describe, expect, it } from "vitest";

import { runScenario } from "../../scripts/parity/harness.js";
import { parseScenarioManifest } from "../../scripts/parity/manifest.js";

describe("parity harness", () => {
  it("produces identical evidence for repeated deterministic runs", () => {
    const manifest = parseScenarioManifest({
      schemaVersion: 1,
      id: "repeatable",
      description: "repeatability contract",
      argv: [],
      environment: { allow: [], set: { PATH: "/usr/bin:/bin" } },
      fixtures: [],
      runners: {
        oracle: {
          adapter: "python",
          executable: "node",
          prefixArgs: ["--input-type=module", "-e", 'process.stdout.write("same\\n")'],
        },
        candidate: {
          adapter: "typescript",
          executable: "node",
          prefixArgs: ["--input-type=module", "-e", 'process.stdout.write("same\\n")'],
        },
      },
      limits: { timeoutMs: 10_000, maxOutputBytes: 1_048_576 },
      capture: {
        tree: { enabled: true, root: "profile", exclude: [] },
        sqlite: [],
        events: [],
      },
      comparisons: [
        { class: "byte", field: "process.exitCode" },
        { class: "byte", field: "process.signal" },
        { class: "byte", field: "process.stdout" },
        { class: "byte", field: "process.stderr" },
        { class: "schema", field: "tree" },
      ],
      expectations: [],
      normalizations: [],
    });

    const options = {
      executables: { node: process.execPath },
      pythonExecutable: process.env.PYTHON ?? "python3",
    };
    expect(runScenario(manifest, options)).toEqual(runScenario(manifest, options));
  });

  it("keeps raw dynamic bytes while producing a stable normalized projection", () => {
    const manifest = parseScenarioManifest({
      schemaVersion: 1,
      id: "normalized-projection",
      description: "normalization projection contract",
      argv: [],
      environment: { allow: [], set: { PATH: "/usr/bin:/bin" } },
      fixtures: [],
      runners: {
        oracle: {
          adapter: "python",
          executable: "node",
          prefixArgs: ["--input-type=module", "-e", "process.stdout.write(process.env.HOME)"],
        },
        candidate: {
          adapter: "typescript",
          executable: "node",
          prefixArgs: ["--input-type=module", "-e", "process.stdout.write(process.env.HOME)"],
        },
      },
      limits: { timeoutMs: 10_000, maxOutputBytes: 1_048_576 },
      capture: {
        tree: { enabled: false, root: "profile", exclude: [] },
        sqlite: [],
        events: [],
      },
      comparisons: [{ class: "byte", field: "process.stdout" }],
      expectations: [],
      normalizations: [
        {
          field: "process.stdout",
          kind: "replace-runtime-path",
          source: "home",
          replacement: "<HOME>",
        },
      ],
    });
    const options = { pythonExecutable: process.env.PYTHON ?? "python3" };
    const first = runScenario(manifest, options);
    const second = runScenario(manifest, options);

    expect(first.verdict).toBe("match");
    expect(first.runs.oracle.process.stdout).not.toBe(first.runs.candidate.process.stdout);
    expect(first.runs.oracle.process.stdout).not.toBe(second.runs.oracle.process.stdout);
    expect(first.reproducibility).toEqual(second.reproducibility);
    expect(first.reproducibility.excludedRawPointers).toEqual([
      "/runs/oracle/process/stdout",
      "/runs/candidate/process/stdout",
    ]);
  });

  it("does not inherit an environment variable outside the allowlist", () => {
    const previous = process.env.LOHRA_PARITY_SECRET;
    process.env.LOHRA_PARITY_SECRET = "must-not-leak";
    try {
      const manifest = parseScenarioManifest({
        schemaVersion: 1,
        id: "deny-environment",
        description: "environment deny-by-default",
        argv: [],
        environment: { allow: [], set: { PATH: "/usr/bin:/bin" } },
        fixtures: [],
        runners: {
          oracle: {
            adapter: "python",
            executable: "node",
            prefixArgs: [
              "--input-type=module",
              "-e",
              "process.stdout.write(String(process.env.LOHRA_PARITY_SECRET))",
            ],
          },
          candidate: {
            adapter: "typescript",
            executable: "node",
            prefixArgs: [
              "--input-type=module",
              "-e",
              "process.stdout.write(String(process.env.LOHRA_PARITY_SECRET))",
            ],
          },
        },
        limits: { timeoutMs: 10_000, maxOutputBytes: 1_048_576 },
        capture: {
          tree: { enabled: false, root: "home", exclude: [] },
          sqlite: [],
          events: [],
        },
        comparisons: [{ class: "byte", field: "process.stdout" }],
        expectations: [],
        normalizations: [],
      });
      const evidence = runScenario(manifest, {
        pythonExecutable: process.env.PYTHON ?? "python3",
      });
      expect(Buffer.from(evidence.runs.oracle.process.stdout, "base64").toString("utf8")).toBe(
        "undefined",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.LOHRA_PARITY_SECRET;
      } else {
        process.env.LOHRA_PARITY_SECRET = previous;
      }
    }
  });

  it("fails a versioned absolute expectation even when both runners agree", () => {
    const manifest = parseScenarioManifest({
      schemaVersion: 1,
      id: "wrong-absolute-expectation",
      description: "absolute expectation contract",
      argv: [],
      environment: { allow: [], set: { PATH: "/usr/bin:/bin" } },
      fixtures: [],
      runners: {
        oracle: {
          adapter: "typescript",
          executable: "node",
          prefixArgs: ["--input-type=module", "-e", 'process.stdout.write("actual\\n")'],
        },
        candidate: {
          adapter: "typescript",
          executable: "node",
          prefixArgs: ["--input-type=module", "-e", 'process.stdout.write("actual\\n")'],
        },
      },
      limits: { timeoutMs: 10_000, maxOutputBytes: 1_048_576 },
      capture: {
        tree: { enabled: false, root: "home", exclude: [] },
        sqlite: [],
        events: [],
      },
      comparisons: [{ class: "byte", field: "process.stdout" }],
      expectations: [
        {
          side: "both",
          field: "process.stdout",
          encoding: "utf8",
          value: "expected\n",
        },
      ],
      normalizations: [],
    });
    const evidence = runScenario(manifest);
    expect(evidence.comparison.verdict).toBe("match");
    expect(evidence.verdict).toBe("divergent");
    expect(evidence.expectations.failures).toHaveLength(2);
  });
});
