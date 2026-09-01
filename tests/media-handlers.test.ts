import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelRequest, ModelTransport } from "../src/conversation/types.js";
import {
  createImageGenHandler,
  createMediaBindings,
  createVisionAnalyzeHandler,
  type ImageGenerationPort,
  type ImageGenerationRequest,
} from "../src/media/index.js";
import type { NormalizedResponse } from "../src/transports/index.js";

const roots: string[] = [];
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "lohra-media-handlers-"));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

const response = (content: string | null): NormalizedResponse => ({
  content,
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage: null,
  providerData: null,
});

class VisionStub implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly result: NormalizedResponse | Error) {}
  complete(request: ModelRequest): Promise<NormalizedResponse> {
    this.requests.push(request);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
  close(): void {}
}

class ImageStub implements ImageGenerationPort {
  readonly requests: ImageGenerationRequest[] = [];
  constructor(private readonly result: readonly string[] | Error) {}
  generate(request: ImageGenerationRequest): Promise<readonly string[]> {
    this.requests.push(request);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

describe("vision_analyze handler", () => {
  it("uses path precedence, default prompt and one bounded request", async () => {
    const directory = root();
    const path = join(directory, "a.png");
    writeFileSync(path, "png");
    const runner = new VisionStub(response("seen"));
    const handler = createVisionAnalyzeHandler({
      runner,
      model: "vision-model",
      localRoot: directory,
    });

    expect(await handler({ path, url: "https://example.test/ignored", prompt: "" })).toBe(
      '{"ok": true, "analysis": "seen"}',
    );
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      model: "vision-model",
      maxTokens: 1024,
      temperature: null,
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image in detail." },
            { type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } },
          ],
        },
      ],
    });
    expect(runner.requests[0]).not.toHaveProperty("onText");
  });

  it("keeps whitespace prompt and normalizes null content", async () => {
    const runner = new VisionStub(response(null));
    const handler = createVisionAnalyzeHandler({ runner, model: "m", localRoot: root() });
    expect(await handler({ url: "https://example.test/a", prompt: "   " })).toBe(
      '{"ok": true, "analysis": ""}',
    );
    const message = runner.requests[0]?.messages[0] as { content?: unknown[] } | undefined;
    expect(message?.content?.[0]).toEqual({ type: "text", text: "   " });
  });

  it("rejects truthy non-string fields before fs/runner with redacted envelopes", async () => {
    const runner = new VisionStub(response("unused"));
    const handler = createVisionAnalyzeHandler({ runner, model: "m", localRoot: root() });
    expect(await handler({ url: { secret: "CANARY" } })).toBe(
      '{"error": "vision field \'url\' must be a string, got object"}',
    );
    expect(await handler({ path: ["CANARY"], url: "https://example.test/a" })).toBe(
      '{"error": "vision field \'path\' must be a string, got array"}',
    );
    expect(await handler({ url: "https://example.test/a?secret=CANARY", prompt: ["CANARY"] })).toBe(
      '{"error": "vision field \'prompt\' must be a string, got array"}',
    );
    expect(runner.requests).toHaveLength(0);
  });

  it("wraps validation and provider failures without raw URLs or stacks", async () => {
    const runner = new VisionStub(new Error("provider leaked Bearer SECRET"));
    const handler = createVisionAnalyzeHandler({ runner, model: "m", localRoot: root() });
    const invalid = await handler({ url: "file:///tmp/CANARY" });
    expect(invalid).toContain("unsupported image URL");
    expect(invalid).not.toContain("CANARY");
    const failed = await handler({ url: "https://example.test/a?secret=CANARY" });
    expect(failed).toContain("provider failure");
    expect(failed).not.toContain("SECRET");
    expect(failed).not.toContain("CANARY");
  });

  it("fails closed when the selected profile does not support vision", async () => {
    const runner = new VisionStub(response("unused"));
    const handler = createVisionAnalyzeHandler({
      runner,
      model: "m",
      localRoot: root(),
      supportsVision: false,
    });
    expect(await handler({ url: "https://example.test/a" })).toBe(
      '{"error": "profile does not support vision"}',
    );
    expect(runner.requests).toHaveLength(0);
  });

  it("keeps path and cause in a read-failure envelope", async () => {
    const directory = root();
    const path = join(directory, "unreadable.png");
    writeFileSync(path, "bytes");
    const runner = new VisionStub(response("unused"));
    const handler = createVisionAnalyzeHandler({
      runner,
      model: "m",
      localRoot: directory,
      readFile: () => {
        const error = new Error("EACCES: permission denied");
        Object.assign(error, { code: "EACCES" });
        throw error;
      },
    });
    const envelope = await handler({ path });
    expect(envelope).toContain(`failed to read image ${path}: EACCES: permission denied`);
    expect(envelope).not.toContain("at ");
    expect(runner.requests).toHaveLength(0);
  });
});

describe("image_gen handler and bindings", () => {
  it("coerces prompt/n/size and persists ordered PNG files", async () => {
    const directory = root();
    const generator = new ImageStub([
      Buffer.from("one").toString("base64"),
      Buffer.from("two").toString("base64"),
    ]);
    const ids = ["a".repeat(32), "b".repeat(32)];
    const handler = createImageGenHandler({
      generator,
      outDir: join(directory, "images"),
      uuid: () => ids.shift() ?? "c".repeat(32),
    });
    const result = JSON.parse(await handler({ prompt: [1, "x"], n: "2", size: "512x512" })) as {
      images: string[];
    };
    expect(generator.requests).toEqual([
      {
        prompt: "[1, 'x']",
        model: "gpt-image-1",
        n: 2,
        size: "512x512",
        timeoutMs: 60_000,
        maxResponseBytes: 96 * 1024 * 1024,
      },
    ]);
    expect(result.images.map((path) => readFileSync(path, "utf8"))).toEqual(["one", "two"]);
    expect(result.images.map((path) => path.slice(-36))).toEqual([
      `${"a".repeat(32)}.png`,
      `${"b".repeat(32)}.png`,
    ]);
  });

  it("rejects blank prompts and provider over-return without files", async () => {
    const directory = root();
    const blank = new ImageStub([]);
    const blankHandler = createImageGenHandler({
      generator: blank,
      outDir: join(directory, "blank"),
    });
    expect(await blankHandler({ prompt: "   " })).toBe(
      '{"error": "image_gen requires a non-empty prompt"}',
    );
    expect(blank.requests).toHaveLength(0);

    const over = new ImageStub(["YQ==", "Yg=="]);
    const overHandler = createImageGenHandler({ generator: over, outDir: join(directory, "over") });
    expect(await overHandler({ prompt: "x", n: 1 })).toContain("returned 2 images for requested 1");
    expect(() => readFileSync(join(directory, "over", `${"a".repeat(32)}.png`))).toThrow();
  });

  it("preserves the exact unsupported-provider envelope", async () => {
    const directory = root();
    const unsupported = new ImageStub(new Error("this provider does not support image generation"));
    const handler = createImageGenHandler({
      generator: unsupported,
      outDir: join(directory, "images"),
    });
    expect(await handler({ prompt: "x" })).toBe(
      '{"error": "this provider does not support image generation"}',
    );
  });

  it("composes bound handlers and delegates every other name exactly once", async () => {
    const directory = root();
    const base = vi.fn((name: string) => Promise.resolve(`base:${name}`));
    const runner = new VisionStub(response("ok"));
    const generator = new ImageStub([]);
    const bindings = createMediaBindings({
      baseDispatch: base,
      localRoot: directory,
      outDir: join(directory, "images"),
      visionRunner: runner,
      imageGenerator: generator,
      visionModel: "m",
      supportsVision: false,
    });
    expect(await bindings.dispatch("other", {})).toBe("base:other");
    expect(await bindings.dispatch("image_gen", { prompt: "x" })).toBe(
      '{"ok": true, "images": []}',
    );
    expect(base).toHaveBeenCalledTimes(1);
    expect(bindings.handlers).toHaveProperty("vision_analyze");
    expect(bindings.handlers).toHaveProperty("image_gen");
    expect(await bindings.dispatch("vision_analyze", { url: "https://example.test/a" })).toBe(
      '{"error": "profile does not support vision"}',
    );
  });
});
