import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseScenarioManifest } from "../../scripts/parity/manifest.js";

const scenarios = [
  "oracle-version",
  "oracle-no-subcommand",
  "oracle-workflow-list",
  "events-jsonl-fixture",
  "deliberate-divergence",
];

describe("versioned scenarios", () => {
  it.each(scenarios)("parses %s without an author-local absolute path", (name) => {
    const path = resolve(`scripts/parity/scenarios/${name}.json`);
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("/Users/");
    expect(source).not.toContain(".oracle-venv/bin/lohra");
    expect(parseScenarioManifest(JSON.parse(source) as unknown).id).toBe(name);
  });

  it("declares the volatile SQLite shm exclusion only in workflow capture policy", () => {
    const source = JSON.parse(
      readFileSync(resolve("scripts/parity/scenarios/oracle-workflow-list.json"), "utf8"),
    ) as { capture: { tree: { exclude: string[] } } };
    expect(source.capture.tree.exclude).toEqual([".lohra/state.db-shm"]);
  });
});
