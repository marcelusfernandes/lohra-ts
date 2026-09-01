import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../src/context/index.js";
import { buildSubagentSystemPrompt } from "../src/orchestration/subagent-prompt.js";

describe("buildSubagentSystemPrompt", () => {
  it("matches the byte-measured oracle text (evidence-s01-child-real.json: child_system_full)", () => {
    // Fixed via buildSystemPrompt's own today override so this pins the
    // static three-paragraph structure without depending on the pending
    // T09 UTC-vs-local-date fix landing on this file first.
    const text = buildSubagentSystemPrompt({ today: "2026-08-30" });
    expect(text).toBe(
      "You are Lohra, a self-improving AI assistant. You are helpful, " +
        "knowledgeable, and direct. You use tools to take real action and you " +
        "never fabricate results — reporting a blocker honestly is always better " +
        "than inventing an outcome.\n\n" +
        "You are an isolated subagent spawned to complete one specific task. You " +
        "have no access to the parent conversation, its memory, or its skills, " +
        "and you cannot delegate further. Use the available tools to complete " +
        "the task, then end with a concise summary of what you did and the " +
        "outcome.\n\n" +
        "Today's date is 2026-08-30.",
    );
  });

  it("carries no memory, user-profile, or skills sections — a child has no access to those stores", () => {
    const text = buildSubagentSystemPrompt({ today: "2026-08-30" });
    expect(text).not.toContain("<memory>");
    expect(text).not.toContain("<user-profile>");
  });

  it("reuses buildSystemPrompt's own date default when no override is given, inheriting the pending T09 local-date fix automatically", () => {
    const viaShared = buildSystemPrompt({}).text.match(/Today's date is (.+)\.$/)?.[1];
    const viaSubagent = buildSubagentSystemPrompt().match(/Today's date is (.+)\.$/)?.[1];
    expect(viaSubagent).toBe(viaShared);
  });
});
