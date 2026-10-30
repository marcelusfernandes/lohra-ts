import { posix, win32 } from "node:path";

import { resolveUserHome } from "../config/paths.js";

export const MANAGED_SKILL_NAME = "use-lohra-ts";
export type SkillClientId = "claude" | "codex" | "opencode" | "pi";
export interface SkillClient {
  readonly id: SkillClientId;
  readonly name: string;
  readonly skillsDirectory: string;
  /** Other documented global sources; discovery can depend on client settings. */
  readonly additionalDiscoveryDirectories: readonly string[];
  readonly discoveryNote: string;
}
export interface SkillClientOptions {
  readonly systemHome?: string;
  readonly platform?: NodeJS.Platform;
}
// Sources: learn.chatgpt.com/docs/build-skills; code.claude.com/docs/en/skills
// and /env-vars; opencode.ai/docs/skills/ and /config/;
// github.com/earendil-works/pi: packages/coding-agent/docs/configuration.md.
// OPENCODE_CONFIG_DIR adds a discovery source; it does not isolate a client.
export function resolveSkillClient(
  name: string,
  environment: Readonly<Record<string, string | undefined>> = {},
  options: SkillClientOptions = {},
): SkillClient {
  const normalized = name.trim().toLowerCase().replace(/\s+/gu, " ");
  const id = normalized === "claude code" ? "claude" : normalized;
  if (id !== "claude" && id !== "codex" && id !== "opencode" && id !== "pi") {
    throw new Error(`unknown skill client '${name}' — choose Claude Code, Codex, OpenCode, or Pi`);
  }
  const paths = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  const home = resolveUserHome(environment, options.systemHome);
  const agentsSkills = paths.join(home, ".agents", "skills");
  const claudeSkills = paths.join(home, ".claude", "skills");
  const opencodeSkills = paths.join(
    environment.XDG_CONFIG_HOME || paths.join(home, ".config"),
    "opencode",
    "skills",
  );
  const definitions: Record<
    SkillClientId,
    { name: string; directory: string; additional: string[] }
  > = {
    claude: {
      name: "Claude Code",
      directory: paths.join(environment.CLAUDE_CONFIG_DIR || paths.join(home, ".claude"), "skills"),
      additional: [],
    },
    codex: { name: "Codex", directory: agentsSkills, additional: [] },
    opencode: {
      name: "OpenCode",
      directory: environment.OPENCODE_CONFIG_DIR
        ? paths.join(environment.OPENCODE_CONFIG_DIR, "skills")
        : opencodeSkills,
      additional: [opencodeSkills, claudeSkills, agentsSkills],
    },
    pi: {
      name: "Pi",
      directory: paths.join(
        environment.PI_CODING_AGENT_DIR || paths.join(home, ".pi", "agent"),
        "skills",
      ),
      additional: [agentsSkills],
    },
  };
  const client = definitions[id];
  return {
    id,
    name: client.name,
    skillsDirectory: client.directory,
    additionalDiscoveryDirectories: [...new Set(client.additional)].filter(
      (directory) => directory !== client.directory,
    ),
    discoveryNote:
      "Clients can discover shared skill directories. Removing this copy does not disable copies in other sources; discovery also depends on client settings.",
  };
}
export function listSkillClients(
  environment: Readonly<Record<string, string | undefined>> = {},
  options: SkillClientOptions = {},
): SkillClient[] {
  return ["claude", "codex", "opencode", "pi"].map((name) =>
    resolveSkillClient(name, environment, options),
  );
}
