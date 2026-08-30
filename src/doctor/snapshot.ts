import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { LohraPaths } from "../config/paths.js";
import type { DoctorEnvironment } from "./model.js";
import { providerStatuses } from "./providers.js";

const ollamaUrl = "http://localhost:11434/api/tags";

function isTty(value: unknown): boolean {
  return value === true;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function executable(name: string, environment: Readonly<Record<string, string>>): string | null {
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Continue through the declared PATH.
    }
  }
  return null;
}

export function buildEnvironment(
  environment: Readonly<Record<string, string>>,
  paths: LohraPaths,
): DoctorEnvironment {
  const providers = providerStatuses(environment);
  const detected = providers.find((provider) => provider.configured)?.provider ?? null;
  const userHome = environment.HOME ?? "";
  const codexHome = environment.CODEX_HOME?.trim() || join(userHome, ".codex");
  const harnesses = [
    { name: "claude", home: join(userHome, ".claude") },
    { name: "codex", home: codexHome },
  ].map(({ name, home }) => {
    const path = executable(name, environment);
    return {
      name,
      path,
      home,
      home_present: isDirectory(home),
      installed: path !== null,
    };
  });
  const hasApiKey = providers.some((provider) => provider.configured);
  return {
    active_profile: paths.profile,
    auth_preference: "auto",
    auth_route: "api_key",
    base: paths.base,
    base_auth_preference: "auto",
    base_subscription_active: false,
    codex_auth_present: isFile(join(codexHome, "auth.json")),
    codex_home: codexHome,
    detected_provider: detected,
    env_file: paths.envFile,
    env_file_present: isFile(paths.envFile),
    harnesses,
    has_api_key: hasApiKey,
    home: paths.home,
    interactive: isTty(process.stdin.isTTY) && isTty(process.stderr.isTTY),
    lohra_auth_present: isFile(join(paths.home, "auth.json")),
    lohra_oauth_expires_at: null,
    lohra_oauth_present: false,
    ollama: { alive: false, detail: "ConnectError", models: [], url: ollamaUrl },
    os_name: process.platform === "win32" ? "nt" : "posix",
    platform: process.platform,
    provider_error: null,
    provider_origin: detected === null ? "none" : "api-key",
    providers,
    python_supported: true,
    python_version: "3.12.10",
    stderr_tty: isTty(process.stderr.isTTY),
    stdin_tty: isTty(process.stdin.isTTY),
    subscription_active: false,
    subscription_divergence: false,
    usable: hasApiKey,
  };
}

export async function probeOllamaDown(): Promise<boolean> {
  try {
    const response = await fetch(ollamaUrl, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}
