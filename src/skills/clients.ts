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
export function resolveSkillClient(
  _name: string,
  _environment: Readonly<Record<string, string | undefined>> = {},
  _options: SkillClientOptions = {},
): SkillClient {
  throw new Error("not implemented: resolveSkillClient");
}
export function listSkillClients(
  _environment: Readonly<Record<string, string | undefined>> = {},
  _options: SkillClientOptions = {},
): SkillClient[] {
  throw new Error("not implemented: listSkillClients");
}
