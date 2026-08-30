import type { ProviderApiMode } from "../providers/index.js";
import { AnthropicMessagesTransport } from "./anthropic-messages.js";
import { ChatCompletionsTransport } from "./chat-completions.js";
import { ResponsesTransport } from "./responses.js";

export type ProviderTransport =
  AnthropicMessagesTransport | ChatCompletionsTransport | ResponsesTransport;

const factories = new Map<ProviderApiMode, () => ProviderTransport>([
  ["anthropic_messages", () => new AnthropicMessagesTransport()],
  ["chat_completions", () => new ChatCompletionsTransport()],
  ["responses", () => new ResponsesTransport()],
]);

export function registerTransport(mode: ProviderApiMode, factory: () => ProviderTransport): void {
  factories.set(mode, factory);
}

export function getTransport(mode: ProviderApiMode): ProviderTransport | null {
  return factories.get(mode)?.() ?? null;
}

export function listTransports(): readonly ProviderApiMode[] {
  return [...factories.keys()];
}
