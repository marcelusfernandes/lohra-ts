import { isAbsolute, resolve } from "node:path";
import type { ModelTransport } from "../conversation/types.js";
import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolHandler } from "../tools/types.js";
import { IMAGE_REQUEST_TIMEOUT_MS, MAX_IMAGE_RESPONSE_BYTES } from "./constants.js";
import {
  coerceImageCount,
  coerceImagePrompt,
  coerceImageSize,
  jsonType,
  pythonTruthy,
} from "./coercion.js";
import { safeMediaMessage } from "./errors.js";
import { createOutputPlan, persistGeneratedImages } from "./persistence.js";
import { buildImagePart, captureLocalRoot, textPart } from "./source.js";
import type { ImageGenerationPort } from "./types.js";

const DEFAULT_VISION_PROMPT = "Describe this image in detail.";

function visionString(field: string, value: unknown): string {
  if (typeof value !== "string")
    throw new Error(`vision field '${field}' must be a string, got ${jsonType(value)}`);
  return value;
}

export function createVisionAnalyzeHandler(options: {
  readonly runner: ModelTransport;
  readonly model: string;
  readonly localRoot?: string;
  readonly supportsVision?: boolean;
  readonly afterInputPreflight?: () => void | Promise<void>;
  readonly readFile?: (path: string) => Buffer;
}): ToolHandler {
  const localRoot = resolve(options.localRoot ?? process.cwd());
  const rootGuard = captureLocalRoot(localRoot);
  return async (args) => {
    try {
      if (options.supportsVision === false) throw new Error("profile does not support vision");
      const rawPrompt = args["prompt"];
      const prompt = pythonTruthy(rawPrompt)
        ? visionString("prompt", rawPrompt)
        : DEFAULT_VISION_PROMPT;
      const rawPath = args["path"];
      const rawUrl = args["url"];
      let part;
      if (pythonTruthy(rawPath)) {
        part = await buildImagePart({
          path: visionString("path", rawPath),
          localRoot,
          rootGuard,
          ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
          ...(options.afterInputPreflight === undefined
            ? {}
            : { afterInputPreflight: options.afterInputPreflight }),
        });
      } else if (pythonTruthy(rawUrl)) {
        part = await buildImagePart({ url: visionString("url", rawUrl), localRoot, rootGuard });
      } else {
        throw new Error("vision_analyze requires a 'path' or a 'url'");
      }
      let result;
      try {
        result = await options.runner.complete({
          system: "",
          messages: [{ role: "user", content: [textPart(prompt), part] }],
          model: options.model,
          temperature: null,
          effort: null,
          maxTokens: 1024,
          tools: [],
          signal: new AbortController().signal,
        });
      } catch (error) {
        throw new Error(safeMediaMessage(error, "provider failure"), { cause: error });
      }
      return toolResult(undefined, { analysis: result.content ?? "" });
    } catch (error) {
      return toolError(safeMediaMessage(error).replace(/^Error: /, ""));
    }
  };
}

export function createImageGenHandler(options: {
  readonly generator: ImageGenerationPort;
  readonly outDir?: string;
  readonly model?: string;
  readonly uuid?: () => string;
  readonly afterRootPreflight?: () => void | Promise<void>;
  readonly beforePublish?: (index: number, path: string) => void | Promise<void>;
}): ToolHandler {
  const cwd = process.cwd();
  const outDir = options.outDir ?? resolve(cwd, "images");
  const plan = createOutputPlan(outDir);
  return async (args) => {
    try {
      const prompt = coerceImagePrompt(args["prompt"]);
      const n = coerceImageCount(args["n"]);
      const size = coerceImageSize(args["size"]);
      let payloads;
      try {
        payloads = await options.generator.generate({
          prompt,
          model: options.model ?? "gpt-image-1",
          n,
          ...(size === undefined ? {} : { size }),
          timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
          maxResponseBytes: MAX_IMAGE_RESPONSE_BYTES,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "this provider does not support image generation"
        ) {
          throw error;
        }
        throw new Error(safeMediaMessage(error, "provider failure"), { cause: error });
      }
      const images = await persistGeneratedImages({
        plan,
        payloads,
        requested: n,
        ...(options.uuid === undefined ? {} : { uuid: options.uuid }),
        ...(options.afterRootPreflight === undefined
          ? {}
          : { afterRootPreflight: options.afterRootPreflight }),
        ...(options.beforePublish === undefined ? {} : { beforePublish: options.beforePublish }),
      });
      return toolResult(undefined, { images });
    } catch (error) {
      return toolError(safeMediaMessage(error).replace(/^Error: /, ""));
    }
  };
}

export function assertAbsoluteMediaRoots(localRoot: string, outDir: string): void {
  if (!isAbsolute(localRoot)) throw new Error("localRoot must be absolute");
  if (!isAbsolute(outDir)) throw new Error("outDir must be absolute");
}
