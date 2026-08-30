import { ChatCompletionsClient, ChatCompletionsTransport } from "../transports/index.js";
import type { ModelRequest, ModelTransport } from "./types.js";

export class ChatCompletionsModel implements ModelTransport {
  private readonly adapter = new ChatCompletionsTransport();

  public constructor(private readonly client: ChatCompletionsClient) {}

  public complete(request: ModelRequest) {
    return this.client.create(
      this.adapter.buildKwargs({
        model: request.model,
        messages: request.messages,
        system: request.system,
        tools: request.tools,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      }),
      request.signal,
    );
  }

  public close(): Promise<void> {
    return this.client.close();
  }
}
