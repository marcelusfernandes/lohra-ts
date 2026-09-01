import { NativeChatHttpPort } from "../transports/client.js";
import type { ChatHttpPort } from "../transports/types.js";
import type { ImageGenerationPort, ImageGenerationRequest } from "./types.js";

export interface OpenAIImagesOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly http?: ChatHttpPort;
}

export class OpenAIImagesAdapter implements ImageGenerationPort {
  private readonly http: ChatHttpPort;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIImagesOptions) {
    this.http = options.http ?? new NativeChatHttpPort();
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  async generate(request: ImageGenerationRequest): Promise<readonly string[]> {
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      n: request.n,
    };
    if (request.size !== undefined) body["size"] = request.size;
    const response = await this.http.post({
      url: `${this.baseUrl}/images/generations`,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxResponseBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error(`image generation HTTP ${String(response.status)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      throw new Error("image generation returned invalid JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("data" in parsed) ||
      !Array.isArray(parsed.data)
    )
      throw new Error("image generation returned invalid response shape");
    return Object.freeze(
      parsed.data.flatMap((entry: unknown) => {
        if (typeof entry !== "object" || entry === null || !("b64_json" in entry)) return [];
        const value = entry.b64_json;
        return typeof value === "string" && value.length > 0 ? [value] : [];
      }),
    );
  }

  close(): void | Promise<void> {
    return this.http.close?.();
  }
}
