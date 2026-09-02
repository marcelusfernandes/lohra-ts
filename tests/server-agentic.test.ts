import { describe, expect, it } from "vitest";

import {
  AGENTIC_MAX_ITERATIONS,
  buildAllowedTools,
  RELAY_MAX_ITERATIONS,
} from "../src/server/agentic.js";

describe("relay/agentic iteration limits (assertion 52)", () => {
  it("relay is 8, agentic is 90 — named exports a probe can grep for", () => {
    expect(RELAY_MAX_ITERATIONS).toBe(8);
    expect(AGENTIC_MAX_ITERATIONS).toBe(90);
  });
});

describe("buildAllowedTools — server allowlist over the subagent guards", () => {
  it("--tools read_file,memory,delegate_task,nosuchtool exposes only read_file (assertion 53)", () => {
    const { definitions } = buildAllowedTools(["read_file", "memory", "delegate_task", "nosuchtool"]);
    expect(definitions.map((d) => d.function.name)).toEqual(["read_file"]);
  });

  it("allowlist order follows the registry, not the CSV (assertion 54)", () => {
    const { definitions } = buildAllowedTools(["terminal", "read_file"]);
    expect(definitions.map((d) => d.function.name)).toEqual(["read_file", "terminal"]);
  });

  it("dispatch of a non-allow-listed tool refuses with the exact server allow-list message (assertion 55)", async () => {
    const { dispatcher } = buildAllowedTools(["read_file"]);
    const result = await dispatcher.dispatch({ id: "1", name: "terminal", arguments: "{}" });
    expect(JSON.parse(result["content"] as string)).toEqual({
      error: "tool 'terminal' is not in the server allow-list",
    });
  });

  it("an excluded/intercepted tool not on the allowlist gets the allow-list message, not the deny-list one", async () => {
    const { dispatcher } = buildAllowedTools(["read_file"]);
    const result = await dispatcher.dispatch({ id: "1", name: "memory", arguments: "{}" });
    expect(JSON.parse(result["content"] as string)).toEqual({
      error: "tool 'memory' is not in the server allow-list",
    });
  });

  it("an empty --tools list exposes nothing", () => {
    const { definitions, names } = buildAllowedTools([]);
    expect(definitions).toEqual([]);
    expect(names).toEqual([]);
  });
});
