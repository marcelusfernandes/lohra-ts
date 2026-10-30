import { describe, expect, it } from "vitest";
import { listSkillClients, MANAGED_SKILL_NAME, resolveSkillClient } from "../src/skills/clients.js";

const environment = { HOME: "/fixture/user", PATH: "" };
const options = { platform: "linux", systemHome: "/fixture/system" } as const;

describe("skill client catalog", () => {
  it("normalizes aliases and case without requiring executables", () => {
    for (const [name, id] of [
      ["Claude", "claude"],
      [" claUde   Code ", "claude"],
      ["CODEX", "codex"],
      ["OpenCode", "opencode"],
      ["pI", "pi"],
    ]) {
      expect(resolveSkillClient(name as string, environment, options).id).toBe(id);
    }
    expect(() => resolveSkillClient("OpenRouter", environment, options)).toThrow(
      "unknown skill client",
    );
    expect(() => resolveSkillClient("", environment, options)).toThrow("unknown skill client");
  });
  it("resolves the four documented default global roots and TS kit", () => {
    expect(MANAGED_SKILL_NAME).toBe("use-lohra-ts");
    expect(
      listSkillClients(environment, options).map((client) => [client.name, client.skillsDirectory]),
    ).toEqual([
      ["Claude Code", "/fixture/user/.claude/skills"],
      ["Codex", "/fixture/user/.agents/skills"],
      ["OpenCode", "/fixture/user/.config/opencode/skills"],
      ["Pi", "/fixture/user/.pi/agent/skills"],
    ]);
  });
  it("uses the existing HOME fallback and supports Windows paths without disk access", () => {
    expect(resolveSkillClient("Codex", {}, options).skillsDirectory).toBe(
      "/fixture/system/.agents/skills",
    );
    expect(resolveSkillClient("Codex", { HOME: "" }, options).skillsDirectory).toBe(
      "/fixture/system/.agents/skills",
    );
    expect(
      resolveSkillClient(
        "OpenCode",
        { HOME: "C:\\Users\\fixture" },
        { platform: "win32", systemHome: "D:\\fallback" },
      ).skillsDirectory,
    ).toBe("C:\\Users\\fixture\\.config\\opencode\\skills");
  });
  it("respects documented overrides and does not use CODEX_HOME for skills", () => {
    const env = {
      ...environment,
      CLAUDE_CONFIG_DIR: "/fixture/claude",
      CODEX_HOME: "/fixture/codex",
      OPENCODE_CONFIG_DIR: "/fixture/opencode",
      XDG_CONFIG_HOME: "/fixture/xdg",
      PI_CODING_AGENT_DIR: "/fixture/pi",
    };
    expect(listSkillClients(env, options).map((client) => client.skillsDirectory)).toEqual([
      "/fixture/claude/skills",
      "/fixture/user/.agents/skills",
      "/fixture/opencode/skills",
      "/fixture/pi/skills",
    ]);
    expect(
      resolveSkillClient("OpenCode", { ...environment, XDG_CONFIG_HOME: "/fixture/xdg" }, options)
        .skillsDirectory,
    ).toBe("/fixture/xdg/opencode/skills");
    expect(
      resolveSkillClient("Pi", { ...environment, PI_CODING_AGENT_DIR: "" }, options)
        .skillsDirectory,
    ).toBe("/fixture/user/.pi/agent/skills");
  });
  it("reports shared discovery without promising an isolated uninstall", () => {
    const opencode = resolveSkillClient(
      "OpenCode",
      { ...environment, OPENCODE_CONFIG_DIR: "/fixture/custom" },
      options,
    );
    expect(opencode.additionalDiscoveryDirectories).toEqual([
      "/fixture/user/.config/opencode/skills",
      "/fixture/user/.claude/skills",
      "/fixture/user/.agents/skills",
    ]);
    expect(resolveSkillClient("Pi", environment, options).additionalDiscoveryDirectories).toEqual([
      "/fixture/user/.agents/skills",
    ]);
    expect(opencode.discoveryNote).toContain("Removing this copy");
    expect(opencode.discoveryNote).toContain("other sources");
  });
  it("returns independent arrays and client objects", () => {
    const first = listSkillClients(environment, options);
    first.pop();
    expect(listSkillClients(environment, options)).toHaveLength(4);
    expect(resolveSkillClient("Pi", environment, options)).not.toBe(
      resolveSkillClient("Pi", environment, options),
    );
    expect(resolveSkillClient("Pi", environment, options).additionalDiscoveryDirectories).not.toBe(
      resolveSkillClient("Pi", environment, options).additionalDiscoveryDirectories,
    );
  });
});
