import { describe, expect, it } from "vitest";

import { CHILD_EXCLUDED_TOOLS, childToolDefinitions } from "../src/tools/child.js";
import { composeDispatch } from "../src/tools/dispatch.js";
import type { RegistryDispatch, ToolDefinition } from "../src/tools/types.js";
import { OrchestrationCore, type CollectResult } from "../src/orchestration/core.js";
import { orchestrationToolHandlers } from "../src/orchestration/chat-wiring.js";
import type { ProviderResolver } from "../src/orchestration/tools.js";

const stubPrompt = (): string => "SUBAGENT_SYSTEM_STUB";
const allowAllProviders: ProviderResolver = { get: () => Promise.resolve([{}, {}]) };

const okResult: CollectResult = {
  status: "complete",
  output: "done",
  tokensIn: 1,
  tokensOut: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  provider: "fakeprov",
  model: "fake-model-a",
  forcedFallback: false,
  errorKind: null,
  retryAfter: null,
};

function makeCore(): OrchestrationCore {
  let n = 0;
  return new OrchestrationCore({
    runChild: () => Promise.resolve(okResult),
    idSource: () => {
      n += 1;
      return `id-${String(n)}`;
    },
    maxSubsessions: 200,
    maxParallel: 4,
    buildSubagentPrompt: stubPrompt,
  });
}

describe("orchestrationToolHandlers", () => {
  it("exposes exactly the four intercepted verbs, no more, no fewer", () => {
    const handlers = orchestrationToolHandlers(makeCore(), allowAllProviders);
    expect(Object.keys(handlers).sort()).toEqual(
      ["collect_session", "delegate_task", "spawn_session", "steer_session"].sort(),
    );
  });

  it("actually spawns via the real core — not a fail-safe refusal — when composed into a dispatch table", async () => {
    const core = makeCore();
    const base: RegistryDispatch = () => Promise.resolve("SHOULD_NOT_BE_CALLED");
    const dispatch = composeDispatch(base, orchestrationToolHandlers(core, allowAllProviders));

    const envelope = await dispatch("spawn_session", { prompt: "do it" });

    const parsed = JSON.parse(envelope) as { ok: boolean; sub_id: string };
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.sub_id).toBe("string");
    expect(core.size).toBe(1);
  });

  it("leaves a non-intercepted tool falling through to the base dispatch unchanged", async () => {
    const calls: [string, unknown][] = [];
    const base: RegistryDispatch = (name, args) => {
      calls.push([name, args]);
      return Promise.resolve("BASE-RESULT");
    };
    const dispatch = composeDispatch(base, orchestrationToolHandlers(makeCore(), allowAllProviders));

    const result = await dispatch("read_file", { path: "x.txt" });

    expect(result).toBe("BASE-RESULT");
    expect(calls).toEqual([["read_file", { path: "x.txt" }]]);
  });

  it("does not let a child inherit the four orchestration verbs even once they're real, wired handlers on the parent's catalog", () => {
    // The parent's own tool catalog, as it looks AFTER this slice wires real
    // handlers in place of the FAIL_SAFE_HANDLERS placeholders for these
    // four names — childToolDefinitions must still filter them out via the
    // inherited, untouched CHILD_TOOL_ALLOWLIST (child.ts), regardless of
    // what the parent's dispatch table does with them.
    const parentCatalog: readonly ToolDefinition[] = [
      { type: "function", function: { name: "read_file", description: "", parameters: {} } },
      { type: "function", function: { name: "spawn_session", description: "", parameters: {} } },
      { type: "function", function: { name: "steer_session", description: "", parameters: {} } },
      { type: "function", function: { name: "collect_session", description: "", parameters: {} } },
      { type: "function", function: { name: "delegate_task", description: "", parameters: {} } },
    ];

    const childCatalog = childToolDefinitions(parentCatalog).map((d) => d.function.name);

    for (const excluded of CHILD_EXCLUDED_TOOLS) expect(childCatalog).not.toContain(excluded);
    expect(childCatalog).toEqual(["read_file"]);
  });
});
