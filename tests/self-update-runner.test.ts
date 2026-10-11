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

  it("keeps the output of a successfully started command", () => {
    const result = defaultCommandRunner(
      process.execPath,
      ["-e", "process.stdout.write('OUT'); process.stderr.write('ERR')"],
      process.cwd(),
    );

    expect(result).toEqual({ code: 0, stdout: "OUT", stderr: "ERR" });
  });

  it("limits oversized output and reports the spawn buffer failure", () => {
    const result = defaultCommandRunner(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2_000_000))"],
      process.cwd(),
    );

    expect(result.code).not.toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_048_576);
    expect(result.stderr).toContain("ENOBUFS");
  });
});
