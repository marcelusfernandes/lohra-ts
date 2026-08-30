import { getProviderProfile, resolveApiKey, type ProviderProfile } from "../providers/index.js";
import { ChatCompletionsTransport } from "./chat-completions.js";
import { AnthropicMessagesTransport } from "./anthropic-messages.js";
import { ResponsesTransport } from "./responses.js";
import {
  AnthropicMessagesClient,
  ChatCompletionsClient,
  ResponsesClient,
  type AnthropicMessagesClientOptions,
  type ChatCompletionsClientOptions,
  type ResponsesClientOptions,
} from "./client.js";

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

export type BuiltProviderClient = ChatCompletionsClient | AnthropicMessagesClient;

export function buildClient(
  profile: ProviderProfile,
  apiKey: string,
  options: Readonly<Record<string, unknown>> = {},
): BuiltProviderClient {
  if (profile.apiMode === "responses")
    throw new Error("ValueError: no client wired for api_mode 'responses'");
  if (profile.apiMode === "anthropic_messages")
    return new AnthropicMessagesClient({
      baseUrl: profile.baseUrl,
      apiKey,
      transport: new AnthropicMessagesTransport(),
      ...(options as Omit<AnthropicMessagesClientOptions, "baseUrl" | "apiKey" | "transport">),
    });
  return new ChatCompletionsClient({
    baseUrl: profile.baseUrl,
    apiKey,
    transport: new ChatCompletionsTransport(),
    ...(options as Omit<ChatCompletionsClientOptions, "baseUrl" | "apiKey" | "transport">),
  });
}

export function createResponsesClient(
  credentials: {
    readonly baseUrl: string;
    readonly token: string;
    readonly accountId?: string | null;
    readonly headers?: Readonly<Record<string, string>>;
  },
  options: Omit<
    ResponsesClientOptions,
    "baseUrl" | "token" | "accountId" | "headers" | "transport"
  > = {},
): ResponsesClient {
  return new ResponsesClient({
    ...options,
    baseUrl: credentials.baseUrl,
    token: credentials.token,
    transport: new ResponsesTransport(),
    ...(credentials.accountId === undefined ? {} : { accountId: credentials.accountId }),
    ...(credentials.headers === undefined ? {} : { headers: credentials.headers }),
  });
}
