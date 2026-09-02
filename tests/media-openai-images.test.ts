import { describe, expect, it } from "vitest";

import { OpenAIImagesAdapter } from "../src/media/index.js";
import type { ChatHttpPort, ChatHttpRequest, HttpResponseData } from "../src/transports/index.js";

const encoder = new TextEncoder();

class Port implements ChatHttpPort {
  readonly requests: ChatHttpRequest[] = [];
  constructor(private readonly result: HttpResponseData | Error) {}
  post(request: ChatHttpRequest): Promise<HttpResponseData> {
    this.requests.push(request);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

const response = (status: number, value: unknown): HttpResponseData => ({
  status,
  headers: new Headers({ "content-type": "application/json" }),
  body: encoder.encode(typeof value === "string" ? value : JSON.stringify(value)),
});

const request = {
  prompt: "draw",
  model: "gpt-image-1",
  n: 2,
  size: "auto",
  timeoutMs: 60_000,
  maxResponseBytes: 96 * 1024 * 1024,
} as const;

describe("OpenAI Images adapter", () => {
  it("posts the exact bounded request and extracts ordered non-empty b64_json", async () => {
    const port = new Port(
      response(200, {
        data: [{ b64_json: "YQ==" }, { revised_prompt: "x" }, { b64_json: "Yg==" }],
      }),
    );
    const adapter = new OpenAIImagesAdapter({
      apiKey: "secret-key",
      baseUrl: "https://images.example/v1/",
      http: port,
    });
    await expect(adapter.generate(request)).resolves.toEqual(["YQ==", "Yg=="]);
    expect(port.requests).toEqual([
      {
        url: "https://images.example/v1/images/generations",
        headers: {
          authorization: "Bearer secret-key",
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-image-1", prompt: "draw", n: 2, size: "auto" }),
        timeoutMs: 60_000,
        maxBytes: 96 * 1024 * 1024,
      },
    ]);
  });

  it("omits absent size and rejects HTTP, JSON and shape failures", async () => {
    const success = new Port(response(200, { data: [] }));
    const adapter = new OpenAIImagesAdapter({ apiKey: "k", http: success });
    await adapter.generate({ ...request, size: undefined });
    expect(JSON.parse(success.requests[0]?.body ?? "null")).not.toHaveProperty("size");

    await expect(
      new OpenAIImagesAdapter({
        apiKey: "k",
        http: new Port(response(401, { error: "SECRET" })),
      }).generate(request),
    ).rejects.toThrow("HTTP 401");
    await expect(
      new OpenAIImagesAdapter({ apiKey: "k", http: new Port(response(200, "{")) }).generate(
        request,
      ),
    ).rejects.toThrow("invalid JSON");
    await expect(
      new OpenAIImagesAdapter({ apiKey: "k", http: new Port(response(200, {})) }).generate(request),
    ).rejects.toThrow("invalid response shape");
  });
});
