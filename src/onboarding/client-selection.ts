import { join } from "node:path";

import { MANAGED_SKILL_NAME, type SkillClient } from "../skills/clients.js";
import {
  ManagedInstallError,
  manageSkillInstallation,
  type ManagedInstallResult,
  type ManagedInstallStatus,
} from "../skills/managed-install.js";

export const CLIENT_SELECTION_TITLE = "clients — arrows move, Space toggles, Enter confirms";
export const CLIENT_SELECTION_HINT =
  "Unchecking a client does not uninstall it. Use `lohra skills remove` to remove one.";

type Installer = (request: {
  readonly action: "add" | "remove";
  readonly skillsDirectory: string;
}) => ManagedInstallResult;

/** Line fallback for an injected reader. The interactive init uses the keyboard selector. */
export function clientsFromLine(
  answer: string,
  clients: readonly SkillClient[],
): readonly SkillClient[] {
  const tokens = answer
    .split(",")
    .map((token) => token.trim().toLowerCase().replace(/\s+/gu, " "))
    .filter((token) => token.length > 0);
  const selected: SkillClient[] = [];
  for (const token of tokens) {
    const id = token === "claude code" ? "claude" : token;
    const client = clients.find((item) => item.id === id || item.name.toLowerCase() === token);
    if (!client) {
      throw new Error(
        `unknown skill client '${token}' — choose Claude Code, Codex, OpenCode, or Pi`,
      );
    }
    if (!selected.some((item) => item.id === client.id)) selected.push(client);
  }
  return selected;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ManagedInstallError ? `${error.code}: ` : "";
  const cause =
    error instanceof Error && error.cause instanceof Error ? `; cause: ${error.cause.message}` : "";
  return `${code}${message}${cause}`;
}

function successLine(
  status: Exclude<ManagedInstallStatus, "removed">,
  client: SkillClient,
  directory: string,
): string {
  switch (status) {
    case "installed":
      return `installed use-lohra-ts for ${client.name} at ${directory}`;
    case "updated":
      return `updated use-lohra-ts for ${client.name} at ${directory}`;
    case "noop":
      return `use-lohra-ts already up to date for ${client.name} at ${directory}`;
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}

function explainDiscovery(client: SkillClient, note: (line: string) => void): void {
  if (client.additionalDiscoveryDirectories.length === 0) return;
  note(
    `${client.name} also discovers skills in ${client.additionalDiscoveryDirectories.join(", ")}. ${client.discoveryNote}`,
  );
}

/**
 * Install or update the packaged kit on the selected clients only.
 * Unselected clients are left untouched — removal is `lohra skills remove`.
 * Returns the number of clients whose install failed.
 */
export function installSelectedClients(
  clients: readonly SkillClient[],
  note: (line: string) => void,
  manage: Installer = manageSkillInstallation,
): number {
  if (clients.length === 0) {
    note("no clients selected; use-lohra-ts was not installed");
    note("Existing installs were left in place. Use `lohra skills remove` to remove one.");
    return 0;
  }
  let failures = 0;
  for (const client of clients) {
    const destination = join(client.skillsDirectory, MANAGED_SKILL_NAME);
    try {
      const result = manage({ action: "add", skillsDirectory: client.skillsDirectory });
      if (result.status === "removed") {
        throw new Error(`skill install for ${client.name} reported removal at ${result.directory}`);
      }
      note(successLine(result.status, client, result.directory));
      if (result.preservedExtras.length > 0) {
        note(`preserved extra files: ${result.preservedExtras.join(", ")}`);
      }
      explainDiscovery(client, note);
    } catch (error) {
      failures += 1;
      note(
        `failed to install use-lohra-ts for ${client.name} at ${destination}: ${describeError(error)}`,
      );
      explainDiscovery(client, note);
    }
  }
  return failures;
}
