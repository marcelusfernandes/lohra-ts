import { describe, expect, it } from "vitest";

import { defaultCommandRunner } from "../src/self-update/repo.js";

describe("self-update command runner", () => {
  it("reports the original cause when an executable cannot start", () => {
    const executable = `lohra-missing-updater-command-816-${String(process.pid)}`;
    const result = defaultCommandRunner(executable, [], process.cwd());

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).toContain(executable);
  });
});
