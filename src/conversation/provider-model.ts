import {
  AnthropicMessagesClient,
  AnthropicMessagesTransport,
  ResponsesClient,
  ResponsesTransport,
  type NormalizedResponse,
} from "../transports/index.js";
import type { ModelRequest, ModelTransport } from "./types.js";

export class AnthropicMessagesModel implements ModelTransport {
  private readonly adapter = new AnthropicMessagesTransport();

  public constructor(
    private readonly client: AnthropicMessagesClient,
    private readonly streaming = false,
  ) {}

  public complete(request: ModelRequest): Promise<NormalizedResponse> {
    const kwargs = this.adapter.buildKwargs({
      model: request.model,
      messages: request.messages,
      system: request.system,
      tools: request.tools,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
    });
    return this.streaming
      ? this.client.stream(kwargs, request.onText ? { onText: request.onText } : {})
      : this.client.create(kwargs, request.signal);
  }

  public close(): Promise<void> {
    return this.client.close();
  }
}

export class ResponsesModel implements ModelTransport {
  private readonly adapter = new ResponsesTransport();

  public constructor(private readonly client: ResponsesClient) {}

  public complete(request: ModelRequest): Promise<NormalizedResponse> {
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
