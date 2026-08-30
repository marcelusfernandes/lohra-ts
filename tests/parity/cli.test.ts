import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../scripts/parity/cli.js";
import { writeEvidence } from "../../scripts/parity/evidence.js";
import type { EvidenceRecord } from "../../scripts/parity/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parity CLI", () => {
  it("maps a harness argument error to exit code 2 with a named cause", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(runCli([])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("[CLI_ARGUMENT]"));
  });

  it("writes canonical evidence atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "lohra-parity-evidence-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "record.json");
    const evidence = {
      schemaVersion: 1,
      scenario: { id: "fixture", manifestSha256: "hash" },
      commands: {
        oracle: { executable: "node", argv: [] },
        candidate: { executable: "node", argv: [] },
      },
      capturePolicy: {
        tree: { enabled: false, root: "home", exclude: [] },
        sqlite: [],
        events: [],
      },
      expectationPolicy: [],
      normalizationPolicy: [],
      runs: {
        oracle: {
          process: { exitCode: 0, signal: null, stdout: "", stderr: "" },
          tree: [],
          sqlite: {},
          events: {},
        },
        candidate: {
          process: { exitCode: 0, signal: null, stdout: "", stderr: "" },
          tree: [],
          sqlite: {},
          events: {},
        },
      },
      comparison: { verdict: "match", differences: [], normalized: {} },
      expectations: { failures: [] },
      reproducibility: { excludedRawPointers: [], projectionSha256: "digest" },
      verdict: "match",
    } satisfies EvidenceRecord;
    writeEvidence(path, evidence);
    expect(readFileSync(path, "utf8")).toMatch(/^\{\n[\s\S]*\n\}\n$/);
  });
});
