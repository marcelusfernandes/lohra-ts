import { ChatCompletionsClient, ChatCompletionsTransport } from "../transports/index.js";
import type { ModelRequest, ModelTransport } from "./types.js";

export class ChatCompletionsModel implements ModelTransport {
  private readonly adapter = new ChatCompletionsTransport();

  public constructor(
    private readonly client: ChatCompletionsClient,
    private readonly streaming = false,
  ) {}

  public complete(request: ModelRequest) {
    const kwargs = this.adapter.buildKwargs({
      model: request.model,
      messages: request.messages,
      system: request.system,
      tools: request.tools,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      effort: request.effort,
    });
    return this.streaming
      ? this.client.stream(kwargs, request.onText ? { onText: request.onText } : {})
      : this.client.create(kwargs, request.signal);
  }

  public close(): Promise<void> {
    return this.client.close();
  }
}
