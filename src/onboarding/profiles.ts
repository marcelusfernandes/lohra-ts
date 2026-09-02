import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { subscriptionActive } from "../auth/credentials.js";
import { validateProfileName } from "../config/paths.js";

const subdirectories = ["memories", "skills", "cron", "logs", "plugins"] as const;

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function ensureHome(home: string): string {
  for (const directory of subdirectories) mkdirSync(join(home, directory), { recursive: true });
  return home;
}

export function listProfiles(base: string): string[] {
  try {
    return readdirSync(join(base, "profiles"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function runProfile(
  action: string,
  name: string | undefined,
  options: { readonly base: string; readonly activeProfile: string | null },
): CommandResult {
  if (action === "list") {
    const profiles = listProfiles(options.base);
    if (profiles.length === 0) {
      return {
        code: 0,
        stdout: "no profiles yet — create one with `lohra profile create <name>`\n",
        stderr: "",
      };
    }
    return {
      code: 0,
      stdout: `${profiles
        .map((profile) => (profile === options.activeProfile ? `* ${profile}` : `  ${profile}`))
        .join("\n")}\n`,
      stderr: "",
    };
  }
  if (!name) return { code: 2, stdout: "", stderr: "profile create needs a name\n" };
  try {
    validateProfileName(name);
  } catch (error) {
    return {
      code: 2,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
  const home = ensureHome(join(options.base, "profiles", name));
  let stdout = `created profile '${name}' at ${home}\n`;
  if (subscriptionActive(options.base) && !subscriptionActive(home)) {
    stdout +=
      "note: this profile does NOT inherit your subscription — it will bill a paid " +
      `API key until you run:  lohra auth enable --profile ${name}\n`;
  }
  return { code: 0, stdout, stderr: "" };
}
