import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertGuardAfter, assertGuardBefore } from "../../scripts/parity/guard.js";
import { runScenario } from "../../scripts/parity/harness.js";
import { parseScenarioManifest } from "../../scripts/parity/manifest.js";

const expected = {
  expectedCommit: "16b4785d803ad0ca364a8a67346a04f949fbf592",
  expectedVersion: "lohra 0.0.11\n",
};
const clean = {
  commit: expected.expectedCommit,
  porcelain: "",
  version: { exitCode: 0, stdout: expected.expectedVersion, stderr: "" },
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("oracle guard", () => {
  it.each([
    [{ ...clean, commit: "wrong" }, "ORACLE_COMMIT_MISMATCH"],
    [
      { ...clean, version: { exitCode: 0, stdout: "lohra 9.9.9\n", stderr: "" } },
      "ORACLE_VERSION_MISMATCH",
    ],
    [{ ...clean, porcelain: " M tracked.py\n" }, "ORACLE_DIRTY"],
  ])("rejects an injected mismatch before executing the target", (snapshot, code) => {
    const directory = mkdtempSync(join(tmpdir(), "lohra-parity-guard-test-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "target-ran");
    const manifest = parseScenarioManifest({
      schemaVersion: 1,
      id: "guard-negative",
      description: "guard negative",
      argv: [],
      environment: { allow: [], set: { PATH: "/usr/bin:/bin", MARKER: marker } },
      fixtures: [],
      runners: {
        oracle: {
          adapter: "typescript",
          executable: "node",
          prefixArgs: [
            "--input-type=module",
            "-e",
            'import {writeFileSync} from "node:fs"; writeFileSync(process.env.MARKER, "ran")',
          ],
        },
        candidate: {
          adapter: "typescript",
          executable: "node",
          prefixArgs: ["--version"],
        },
      },
      limits: { timeoutMs: 1000, maxOutputBytes: 100_000 },
      capture: {
        tree: { enabled: false, root: "home", exclude: [] },
        sqlite: [],
        events: [],
      },
      comparisons: [{ class: "byte", field: "process.exitCode" }],
      expectations: [],
      normalizations: [],
      oracleGuard: expected,
    });
    expect(() =>
      runScenario(manifest, {
        guardProvider: { before: () => snapshot, after: () => clean },
      }),
    ).toThrow(expect.objectContaining({ code }));
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a checkout that becomes dirty after execution", () => {
    expect(() => {
      assertGuardAfter({ commit: expected.expectedCommit, porcelain: "?? new-file\n" }, expected);
    }).toThrow(expect.objectContaining({ code: "ORACLE_DIRTY_AFTER" }));
  });

  it("accepts the exact clean snapshot", () => {
    expect(() => {
      assertGuardBefore(clean, expected);
    }).not.toThrow();
  });
});
