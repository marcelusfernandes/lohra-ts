import { composeDispatch } from "../tools/dispatch.js";
import {
  createImageGenHandler,
  createVisionAnalyzeHandler,
  assertAbsoluteMediaRoots,
} from "./handlers.js";
import type { MediaBindingOptions, MediaBindings } from "./types.js";

export function createMediaBindings(options: MediaBindingOptions): MediaBindings {
  assertAbsoluteMediaRoots(options.localRoot, options.outDir);
  const handlers = Object.freeze({
    vision_analyze: createVisionAnalyzeHandler({
      runner: options.visionRunner,
      model: options.visionModel,
      localRoot: options.localRoot,
    }),
    image_gen: createImageGenHandler({
      generator: options.imageGenerator,
      outDir: options.outDir,
      ...(options.imageModel === undefined ? {} : { model: options.imageModel }),
    }),
  });
  return Object.freeze({ handlers, dispatch: composeDispatch(options.baseDispatch, handlers) });
}
