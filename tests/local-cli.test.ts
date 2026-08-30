import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

function invoke(argv: readonly string[], environment: Record<string, string>) {
  let stdout = "";
  let stderr = "";
  return runCli(argv, {
    environment,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
    isTty: false,
    probeOllama: () => Promise.resolve(false),
  }).then((code) => ({ code, stdout, stderr }));
}

function environment(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "lohra-local-cli-"));
  return {
    HOME: home,
    LOHRA_HOME: join(home, "lohra"),
    CODEX_HOME: join(home, "codex"),
    PATH: "/usr/bin:/bin",
    TZ: "UTC",
  };
}

describe("local context public CLI", () => {
  it("creates and lists profiles", async () => {
    const env = environment();
    expect(await invoke(["profile", "list"], env)).toMatchObject({ code: 0, stderr: "" });
    const created = await invoke(["profile", "create", "team_a"], env);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("created profile 'team_a'");
    env.LOHRA_PROFILE = "team_a";
    expect((await invoke(["profile", "list"], env)).stdout).toBe("* team_a\n");
  });

  it("exports the packaged use-lohra kit", async () => {
    const env = environment();
    const destination = join(env.HOME as string, "export");
    const result = await invoke(["skill", "export", "use-lohra", "--to", destination], env);
    expect(result).toEqual({
      code: 0,
      stdout: `wrote ${destination}/use-lohra/SKILL.md\n`,
      stderr: "",
    });
    expect(readFileSync(join(destination, "use-lohra", "SKILL.md"), "utf8")).toContain(
      "name: use-lohra",
    );
  });

  it("runs init read-only without creating home", async () => {
    const env = environment();
    const result = await invoke(["init", "--no-input"], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Lohra — environment\n");
    expect(result.stdout).toContain("no provider configured");
    expect(result.stderr).toBe("");
    expect(existsSync(env.LOHRA_HOME as string)).toBe(false);
  });
});
