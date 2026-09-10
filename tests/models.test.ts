// Issue #261: `lohra models` still read `workflow_tiers.json` with the
// fail-open `loadTiers` (a broken file silently became `{}`), while `lohra
// tiers` and `WorkflowService.start` already failed closed (#234, PR #256).
// This locks `runModels` onto the same named-error path, in both output
// modes, and before any network work (the tier file is local and cheap to
// check first).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runModels } from "../src/commands/models.js";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "lohra-models-test-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function neverProbe(): Promise<never> {
  return Promise.reject(new Error("must not be called"));
}

describe("runModels — fail-closed tier reading (#261)", () => {
  it("exits 1 on stderr, not stdout, for a broken workflow_tiers.json (text mode)", async () => {
    const home = root();
    writeFileSync(join(home, "workflow_tiers.json"), "[");
    const result = await runModels({
      json: false,
      home,
      environment: {},
      probeOllama: neverProbe,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(join(home, "workflow_tiers.json"));
  });

  it("exits 1 with a named {error} on stdout for a broken workflow_tiers.json (--json)", async () => {
    const home = root();
    writeFileSync(join(home, "workflow_tiers.json"), "[");
    const result = await runModels({
      json: true,
      home,
      environment: {},
      probeOllama: neverProbe,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { readonly error?: string };
    expect(parsed.error).toContain(join(home, "workflow_tiers.json"));
  });

  it("still lists models when workflow_tiers.json is absent", async () => {
    const home = root();
    const result = await runModels({
      json: false,
      home,
      environment: {},
      probeOllama: () =>
        Promise.resolve({ alive: false, detail: "not running", models: [], url: "" }),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });
});
