import { COMMAND_SUMMARY, SKILLS_SPEC, SUBCOMMAND_HELP } from "../cli/arg-spec.js";
import {
  LEVELS,
  parseCommand,
  renderError,
  renderHelp,
  unexpectedArguments,
} from "../cli/arg-validation.js";
import { resolveSkillClient } from "../skills/clients.js";
import { manageSkillInstallation, ManagedInstallError } from "../skills/managed-install.js";

export interface SkillsCommandIo {
  readonly environment: Readonly<Record<string, string>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}
/** Dispatch before loading Lohra paths/.env/auth; only the catalog selects a root. */
export function runSkills(argv: readonly string[], io: SkillsCommandIo): number {
  if (
    argv[0] === "--help" ||
    argv[0] === "-h" ||
    ((argv[0] === "add" || argv[0] === "remove") && (argv[1] === "--help" || argv[1] === "-h"))
  ) {
    io.stdout(
      renderHelp(
        LEVELS.skills,
        SKILLS_SPEC,
        COMMAND_SUMMARY.skills as string,
        SUBCOMMAND_HELP.skills,
      ),
    );
    io.stdout(
      '\nusage: lohra skills add <client>\n       lohra skills remove <client>\n\nclients: Claude (or "Claude Code"), Codex, OpenCode, Pi (case-insensitive).\n',
    );
    return 0;
  }
  const parsed = parseCommand(SKILLS_SPEC, argv);
  if (parsed.error) {
    io.stderr(renderError(parsed.error, LEVELS.skills));
    return 2;
  }
  if (parsed.extras.length) {
    io.stderr(unexpectedArguments(parsed.extras));
    return 2;
  }
  let client;
  try {
    client = resolveSkillClient(parsed.positionals[1] as string, io.environment);
  } catch (error) {
    io.stderr(
      `${LEVELS.skills.banner}lohra: error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const action = parsed.positionals[0] as "add" | "remove";
  let result;
  try {
    result = manageSkillInstallation({ action, skillsDirectory: client.skillsDirectory });
  } catch (error) {
    const code = error instanceof ManagedInstallError ? error.code : "error";
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? `; cause: ${error.cause.message}`
        : "";
    io.stderr(`skills ${action} ${client.name}: ${code}: ${message}${cause}\n`);
    return 2;
  }
  const message =
    result.status === "removed"
      ? "removed managed Lohra installation"
      : result.status === "installed"
        ? "installed managed Lohra installation"
        : result.status === "updated"
          ? "updated managed Lohra installation"
          : action === "add"
            ? "managed Lohra installation already up to date"
            : "no managed Lohra installation to remove";
  io.stdout(`${message} for ${client.name} at ${result.directory}\n`);
  if (result.preservedExtras.length)
    io.stdout(`preserved extra files: ${result.preservedExtras.join(", ")}\n`);
  if (action === "remove") io.stdout(`${client.discoveryNote}\n`);
  return 0;
}
