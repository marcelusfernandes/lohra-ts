import { accessSync, constants, statSync } from "node:fs";
import { get } from "node:http";
import { delimiter, join } from "node:path";

import type { LohraPaths } from "../config/paths.js";
import { AUTO_PROVIDER, resolveProviderName } from "../providers/resolve.js";
import type { DoctorEnvironment, OllamaStatus } from "./model.js";
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
  ollama: OllamaStatus = {
    alive: false,
    detail: "ConnectError",
    models: [],
    url: ollamaUrl,
  },
): DoctorEnvironment {
  const providers = providerStatuses(environment);
  let detected: string | null = null;
  let providerError: string | null = null;
  let providerOrigin: "none" | "api-key" | "env-var" = "none";
  try {
    const resolved = resolveProviderName(undefined, undefined, environment);
    if (resolved !== AUTO_PROVIDER) {
      detected = resolved;
      providerOrigin = (environment.LOHRA_PROVIDER ?? "").trim() ? "env-var" : "api-key";
    }
  } catch (error) {
    providerError = error instanceof Error ? error.message : String(error);
  }
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
    ollama,
    os_name: process.platform === "win32" ? "nt" : "posix",
    platform: process.platform,
    provider_error: providerError,
    provider_origin: providerOrigin,
    providers,
    python_supported: true,
    python_version: "3.12.10",
    stderr_tty: isTty(process.stderr.isTTY),
    stdin_tty: isTty(process.stdin.isTTY),
    subscription_active: false,
    subscription_divergence: false,
    usable: hasApiKey || ollama.alive,
  };
}

export async function probeOllamaDown(): Promise<OllamaStatus> {
  return await new Promise<OllamaStatus>((resolve) => {
    const request = get(
      ollamaUrl,
      { headers: { accept: "*/*", "user-agent": "lohra-ts/0.0.11" }, timeout: 500 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            resolve({ alive: false, detail: `HTTP ${String(status)}`, models: [], url: ollamaUrl });
            return;
          }
          try {
            const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const values =
              typeof payload === "object" && payload !== null && "models" in payload
                ? (payload as { readonly models?: unknown }).models
                : undefined;
            const models = Array.isArray(values)
              ? values.flatMap((entry: unknown) => {
                  if (typeof entry !== "object" || entry === null || !("name" in entry)) return [];
                  const name = (entry as { readonly name?: unknown }).name;
                  return typeof name === "string" ? [name] : [];
                })
              : [];
            resolve({ alive: true, detail: "", models, url: ollamaUrl });
          } catch {
            resolve({ alive: false, detail: "JSONDecodeError", models: [], url: ollamaUrl });
          }
        });
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => {
      resolve({ alive: false, detail: "ConnectError", models: [], url: ollamaUrl });
    });
  });
}
