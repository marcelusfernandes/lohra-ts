import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Managing integrations must never resolve a Lohra profile, load .env, or read tokens.
vi.mock("../src/config/paths.js", async (original) => ({
  ...(await original<typeof import("../src/config/paths.js")>()),
  resolvePaths: vi.fn(() => {
    throw new Error("unexpected Lohra path resolution");
  }),
  resolveCodexHome: vi.fn(() => {
    throw new Error("unexpected credential path resolution");
  }),
}));
vi.mock("../src/config/env-file.js", async (original) => ({
  ...(await original<typeof import("../src/config/env-file.js")>()),
  applyEnvFile: vi.fn(() => {
    throw new Error("unexpected env file load");
  }),
}));
vi.mock("../src/auth/store.js", async (original) => ({
  ...(await original<typeof import("../src/auth/store.js")>()),
  readConfig: vi.fn(() => {
    throw new Error("unexpected auth config read");
  }),
  readTokens: vi.fn(() => {
    throw new Error("unexpected token read");
  }),
}));
vi.mock("../src/skills/managed-install.js", async (original) => {
  const actual = await original<typeof import("../src/skills/managed-install.js")>();
  return { ...actual, manageSkillInstallation: vi.fn(actual.manageSkillInstallation) };
});
import { runCli } from "../src/cli.js";
import { runSkills } from "../src/commands/skills.js";
import { resolvePaths, resolveCodexHome } from "../src/config/paths.js";
import { applyEnvFile } from "../src/config/env-file.js";
import { readConfig, readTokens } from "../src/auth/store.js";
import { manageSkillInstallation, ManagedInstallError } from "../src/skills/managed-install.js";
import { readExportable } from "../src/skills/export.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "lohra-skills-cli-")));
  roots.push(home);
  const environment = {
    HOME: home,
    LOHRA_HOME: join(home, "lohra"),
    LOHRA_PROFILE: "invalid!",
    LOHRA_PROVIDER: "invalid-provider",
    PATH: "",
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex-auth"),
    OPENCODE_CONFIG_DIR: join(home, "opencode"),
    PI_CODING_AGENT_DIR: join(home, "pi"),
  };
  let stdout = "";
  let stderr = "";
  const io = {
    environment,
    stdout: (value: string) => {
      stdout += value;
    },
    stderr: (value: string) => {
      stderr += value;
    },
  };
  return {
    home,
    io,
    invoke: async (argv: string[]) => {
      stdout = "";
      stderr = "";
      const code = await runCli(argv, io);
      return { code, stdout, stderr };
    },
    output: () => ({ stdout, stderr }),
  };
}

describe("skills client commands", () => {
  it("adds each case-insensitive client without credentials, profile or provider initialization", async () => {
    const f = fixture();
    for (const [name, directory] of [
      ["cLaUdE", join(f.home, "claude", "skills")],
      ["CODEX", join(f.home, ".agents", "skills")],
      ["OpenCode", join(f.home, "opencode", "skills")],
      ["Pi", join(f.home, "pi", "skills")],
    ]) {
      expect(await f.invoke(["skills", "add", name as string])).toMatchObject({
        code: 0,
        stderr: "",
      });
      expect(fs.readFileSync(join(directory as string, "use-lohra-ts", "SKILL.md"), "utf8")).toBe(
        readExportable("use-lohra-ts"),
      );
    }
    for (const guarded of [resolvePaths, resolveCodexHome, applyEnvFile, readConfig, readTokens])
      expect(guarded).not.toHaveBeenCalled();
    expect(fs.existsSync(f.io.environment.LOHRA_HOME)).toBe(false);
  });
  it("reports no-op and rejects edited content with a useful conflict", async () => {
    const f = fixture();
    await f.invoke(["skills", "add", "OpenCode"]);
    expect((await f.invoke(["skills", "add", "OpenCode"])).stdout).toContain("already up to date");
    const file = join(f.home, "opencode", "skills", "use-lohra-ts", "SKILL.md");
    fs.writeFileSync(file, "local edit");
    const result = await f.invoke(["skills", "remove", "OpenCode"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("conflict");
    expect(result.stderr).toContain("preserving");
    expect(fs.readFileSync(file, "utf8")).toBe("local edit");
  });
  it("reports scoped removal and shared discovery while preserving extras and shared copies", async () => {
    const f = fixture();
    await f.invoke(["skills", "add", "OpenCode"]);
    const kit = join(f.home, "opencode", "skills", "use-lohra-ts");
    fs.writeFileSync(join(kit, "notes.txt"), "keep");
    const shared = join(f.home, ".agents", "skills", "use-lohra-ts");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(join(shared, "SKILL.md"), "shared copy");
    const result = await f.invoke(["skills", "remove", "OpenCode"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("removed managed Lohra installation");
    expect(result.stdout).toContain("other sources");
    expect(result.stdout).toContain("notes.txt");
    expect(fs.existsSync(join(kit, "SKILL.md"))).toBe(false);
    expect(fs.readFileSync(join(kit, "notes.txt"), "utf8")).toBe("keep");
    expect(fs.readFileSync(join(shared, "SKILL.md"), "utf8")).toBe("shared copy");
    expect((await f.invoke(["skills", "remove", "OpenCode"])).code).toBe(0);
  });
  it("validates usage and client names before filesystem or configuration effects", async () => {
    const f = fixture();
    for (const args of [
      [],
      ["add"],
      ["bogus", "OpenCode"],
      ["add", "OpenRouter"],
      ["add", "OpenCode", "extra"],
      ["add", "OpenCode", "--bad"],
    ]) {
      const result = await f.invoke(["skills", ...args]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("usage: lohra skills");
    }
    expect(fs.readdirSync(f.home)).toEqual([]);
    expect(manageSkillInstallation).not.toHaveBeenCalled();
    for (const guarded of [resolvePaths, resolveCodexHome, applyEnvFile, readConfig, readTokens])
      expect(guarded).not.toHaveBeenCalled();
  });
  it("describes add/remove and destinations in command and main help without side effects", async () => {
    const f = fixture();
    for (const argv of [["skills", "--help"], ["skills", "-h"], ["--help"]]) {
      const result = await f.invoke(argv);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("add");
      expect(result.stdout).toContain("remove");
    }
    expect(fs.readdirSync(f.home)).toEqual([]);
  });
  it("surfaces command failures and their cause without announcing success", () => {
    const f = fixture();
    vi.mocked(manageSkillInstallation).mockImplementationOnce(() => {
      throw new ManagedInstallError(
        "io",
        "could not write managed skill",
        new Error("fixture filesystem failure"),
      );
    });
    expect(runSkills(["add", "OpenCode"], f.io)).toBe(2);
    expect(f.output().stderr).toContain("fixture filesystem failure");
    expect(f.output().stdout).toBe("");
  });
});
