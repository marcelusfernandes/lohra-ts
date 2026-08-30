import { getProviderProfile, resolveApiKey, type ProviderProfile } from "../providers/index.js";
import { ChatCompletionsTransport } from "./chat-completions.js";
import { ChatCompletionsClient, type ChatCompletionsClientOptions } from "./client.js";

export interface ChatCompletionsTarget {
  readonly profile: ProviderProfile;
  readonly apiKey: string;
}

export function resolveChatCompletionsTarget(
  provider: string,
  environment: Readonly<Record<string, string | undefined>>,
): ChatCompletionsTarget {
  const profile = getProviderProfile(provider);
  if (profile === null) throw new Error(`UNKNOWN_PROVIDER:${provider}`);
  if (profile.apiMode !== "chat_completions")
    throw new Error(`UNSUPPORTED_API_MODE:${profile.apiMode}`);
  const resolved = resolveApiKey(profile.name, environment);
  const apiKey = resolved ?? (profile.name === "ollama" ? "lohra-local" : null);
  if (apiKey === null) throw new Error(`PROVIDER_API_KEY_MISSING:${profile.name}`);
  return { profile, apiKey };
}

export function createChatCompletionsClient(
  provider: string,
  environment: Readonly<Record<string, string | undefined>>,
  options: Omit<ChatCompletionsClientOptions, "baseUrl" | "apiKey" | "transport"> = {},
): ChatCompletionsClient {
  const target = resolveChatCompletionsTarget(provider, environment);
  return new ChatCompletionsClient({
    ...options,
    baseUrl: target.profile.baseUrl,
    apiKey: target.apiKey,
    transport: new ChatCompletionsTransport(),
  });
}
