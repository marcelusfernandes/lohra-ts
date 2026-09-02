import type { OllamaStatus } from "../doctor/model.js";
import { getProviderProfile, knownProviderNames, listProviders } from "./registry.js";
import type { ProviderResolution, ResolutionOrigin } from "./types.js";

export const AUTO_PROVIDER = "auto";

function canonical(value: string): string {
  const profile = getProviderProfile(value);
  if (profile === null)
    throw new Error(
      `unknown provider '${value.toLowerCase()}' (known: ${knownProviderNames().join(", ")})`,
    );
  return profile.name;
}

export function resolveProviderName(
  arg?: string | null,
  configValue?: string | null,
  environment: Readonly<Record<string, string | undefined>> = {},
): string {
  const argument = (arg ?? "").trim();
  const config = (configValue ?? "").trim();
  const explicit = (environment.LOHRA_PROVIDER ?? "").trim();
  if (argument) return canonical(argument);
  if (config) return canonical(config);
  if (explicit) return canonical(explicit);
  for (const profile of listProviders())
    if (profile.envVars.some((name) => Boolean(environment[name]))) return profile.name;
  return AUTO_PROVIDER;
}

function origin(
  arg: string | undefined | null,
  config: string | undefined | null,
  env: Readonly<Record<string, string | undefined>>,
): ResolutionOrigin {
  if ((arg ?? "").trim()) return "argument";
  if ((config ?? "").trim()) return "config";
  if ((env.LOHRA_PROVIDER ?? "").trim()) return "env-var";
  return "api-key";
}

export async function resolveProviderChoice(options: {
  readonly arg?: string | null;
  readonly configValue?: string | null;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly probeOllama: () => Promise<OllamaStatus>;
}): Promise<ProviderResolution> {
  const env = options.environment ?? {};
  const name = resolveProviderName(options.arg, options.configValue, env);
  if (name !== AUTO_PROVIDER)
    return { provider: name, origin: origin(options.arg, options.configValue, env), detail: name };
  const status = await options.probeOllama();
  if (status.alive && status.models.length > 0)
    return {
      provider: "ollama",
      origin: "keyless",
      model: status.models[0] as string,
      detail: status.url,
    };
  return { provider: null, origin: "none", error: "no provider configured" };
}

export function resolveApiKey(
  profileName: string,
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const profile = getProviderProfile(profileName);
  if (profile === null) return null;
  for (const name of profile.envVars) {
    const value = environment[name];
    if (value) return value;
  }
  return null;
}
