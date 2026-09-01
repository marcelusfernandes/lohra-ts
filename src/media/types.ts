import type { ModelTransport } from "../conversation/types.js";
import type { RegistryDispatch, ToolHandler } from "../tools/types.js";

export interface ImageGenerationRequest {
  readonly prompt: string;
  readonly model: string;
  readonly n: number;
  readonly size?: unknown;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

export interface ImageGenerationPort {
  generate(request: ImageGenerationRequest): Promise<readonly string[]>;
  close?(): void | Promise<void>;
}

export interface MediaBindings {
  readonly handlers: Readonly<Record<"vision_analyze" | "image_gen", ToolHandler>>;
  readonly dispatch: RegistryDispatch;
}

export interface MediaBindingOptions {
  readonly baseDispatch: RegistryDispatch;
  readonly localRoot: string;
  readonly outDir: string;
  readonly visionRunner: ModelTransport;
  readonly imageGenerator: ImageGenerationPort;
  readonly visionModel: string;
  readonly imageModel?: string;
}
