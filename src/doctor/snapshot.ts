import { accessSync, constants, statSync } from "node:fs";
import { get } from "node:http";
import { delimiter, join } from "node:path";

import type { LohraPaths } from "../config/paths.js";
import { readConfig, readTokens } from "../auth/store.js";
import { resolveAuthRoute, subscriptionActive } from "../auth/credentials.js";
import { readCodexTokens } from "../auth/codex.js";
import { AUTO_PROVIDER, resolveProviderName } from "../providers/resolve.js";
import { jsonFloat } from "../serialization/json-numbers.js";
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
  const config = readConfig(paths.home);
  const baseConfig = readConfig(paths.base);
  const own = readTokens(paths.home);
  const codex = readCodexTokens(codexHome);
  const active = subscriptionActive(paths.home);
  const baseActive = subscriptionActive(paths.base);
  const route = resolveAuthRoute(paths.home);
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
  const snapshot = {
    active_profile: paths.profile,
    auth_preference: config?.preference ?? "auto",
    auth_route: route.error ? "unusable" : route.mode,
    base: paths.base,
    base_auth_preference: baseConfig?.preference ?? "auto",
    base_subscription_active: baseActive,
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
    lohra_oauth_expires_at: own === null ? null : jsonFloat(own.expiresAt),
    lohra_oauth_present: own !== null,
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
    subscription_active: active,
    subscription_divergence: paths.profile !== null && baseActive !== active,
    usable:
      hasApiKey ||
      ollama.alive ||
      (route.mode === "subscription" && (own !== null || codex !== null)),
  };
  Object.defineProperty(snapshot, "timezone", {
    value: environment.TZ ?? "UTC",
    enumerable: false,
  });
  return snapshot as unknown as DoctorEnvironment;
}

export async function probeOllamaDown(): Promise<OllamaStatus> {
  const targetUrl =
    process.env.LOHRA_OLLAMA_CONNECT_URL ?? process.env.LOHRA_OLLAMA_URL ?? ollamaUrl;
  const reportedUrl = process.env.LOHRA_OLLAMA_URL ?? ollamaUrl;
  return await new Promise<OllamaStatus>((resolve) => {
    const request = get(
      targetUrl,
      { headers: { accept: "*/*", "user-agent": "lohra-ts/0.0.11" }, timeout: 500 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            resolve({
              alive: false,
              detail: `HTTP ${String(status)}`,
              models: [],
              url: reportedUrl,
            });
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
            resolve({ alive: true, detail: "", models, url: reportedUrl });
          } catch {
            resolve({ alive: false, detail: "JSONDecodeError", models: [], url: reportedUrl });
          }
        });
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => {
      resolve({ alive: false, detail: "ConnectError", models: [], url: reportedUrl });
    });
  });
}
