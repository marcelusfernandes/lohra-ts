import { describe, expect, it, vi } from "vitest";

import {
  BUILTIN_DEFINITIONS,
  childToolDefinitions,
  createBuiltinRegistry,
  createChildDispatch,
  ToolRegistry,
} from "../src/tools/index.js";

describe("media lifecycle and child defense in depth", () => {
  it("distinguishes unregistered from registered but unbound", async () => {
    const empty = new ToolRegistry();
    expect(await empty.dispatch("vision_analyze", {})).toBe(
      '{"error":"Unknown tool: vision_analyze"}',
    );
    const builtins = createBuiltinRegistry();
    expect(await builtins.dispatch("vision_analyze", {})).toBe(
      '{"error":"the vision_analyze tool must be intercepted with a session runner"}',
    );
    expect(await builtins.dispatch("image_gen", { prompt: "x" })).toBe(
      '{"error":"the image_gen tool must be intercepted with a session runner"}',
    );
  });

  it.each(["vision_analyze", "image_gen"])("removes and denies %s for children", async (name) => {
    const definitions = childToolDefinitions(BUILTIN_DEFINITIONS);
    expect(definitions.some((definition) => definition.function.name === name)).toBe(false);
    const base = vi.fn(() => Promise.resolve("unsafe"));
    const dispatch = createChildDispatch(base);
    expect(await dispatch(name, {})).toBe(
      `{"error":"the '${name}' tool is not available to subagents"}`,
    );
    expect(base).not.toHaveBeenCalled();
  });
});
