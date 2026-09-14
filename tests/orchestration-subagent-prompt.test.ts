import { describe, expect, it } from "vitest";

import { buildSystemPrompt, DOCTRINE_CORE, harnessText } from "../src/context/index.js";
import { childToolDefinitions } from "../src/tools/child.js";
import type { ToolDefinition } from "../src/tools/types.js";
import { buildSubagentSystemPrompt } from "../src/orchestration/subagent-prompt.js";

// Issue #583 (épico #575, P7): the previous byte-exact pin against a
// hardcoded three-paragraph text is gone — the prompt now varies with the
// caller's own `cwd`/`toolNames`, so this suite pins the CONTRACT instead:
// which blocks are present, in what order, and that the tools list is
// always derived from `childToolDefinitions`, never a second, hand-typed
// copy of the five names.
const REAL_TOOL_NAMES: readonly string[] = [
  "read_file",
  "write_file",
  "terminal",
  "web_fetch",
  "web_search",
  "memory",
  "delegate_task",
  "spawn_session",
];

function definition(name: string): ToolDefinition {
  return { type: "function", function: { name, description: name, parameters: {} } };
}

const CHILD_TOOL_NAMES = childToolDefinitions(REAL_TOOL_NAMES.map(definition)).map(
  (item) => item.function.name,
);

describe("buildSubagentSystemPrompt: block presence and order (#583)", () => {
  it("orders identity+isolation, doctrine, harness, Environment, tools contract, then the date", () => {
    const text = buildSubagentSystemPrompt({
      today: "2026-08-30",
      cwd: "/work/project",
      toolNames: CHILD_TOOL_NAMES,
    });

    const identityIndex = text.indexOf("You are Lohra");
    const isolationIndex = text.indexOf("You are an isolated subagent");
    const doctrineIndex = text.indexOf(DOCTRINE_CORE);
    const harnessIndex = text.indexOf(harnessText({ mode: "subagent" }));
    const environmentIndex = text.indexOf("Environment:");
    const cwdIndex = text.indexOf("/work/project");
    const toolsIndex = text.indexOf("Tools available to you:");
    const boundaryIndex = text.indexOf("The task you were given is your boundary");
    const parentIndex = text.indexOf("The parent that spawned you never sees your raw tool output");
    const sentinelIndex = text.indexOf("End your final message with exactly one line");
    const dateIndex = text.indexOf("Today's date is 2026-08-30.");

    for (const index of [
      identityIndex,
      isolationIndex,
      doctrineIndex,
      harnessIndex,
      environmentIndex,
      cwdIndex,
      toolsIndex,
      boundaryIndex,
      parentIndex,
      sentinelIndex,
      dateIndex,
    ]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }

    expect(identityIndex).toBeLessThan(isolationIndex);
    expect(isolationIndex).toBeLessThan(doctrineIndex);
    expect(doctrineIndex).toBeLessThan(harnessIndex);
    expect(harnessIndex).toBeLessThan(environmentIndex);
    expect(environmentIndex).toBeLessThan(cwdIndex);
    expect(cwdIndex).toBeLessThan(toolsIndex);
    expect(toolsIndex).toBeLessThan(boundaryIndex);
    expect(boundaryIndex).toBeLessThan(parentIndex);
    expect(parentIndex).toBeLessThan(sentinelIndex);
    expect(sentinelIndex).toBeLessThan(dateIndex);
  });

  it("lists exactly the tool names childToolDefinitions produces, never a hand-typed copy", () => {
    const text = buildSubagentSystemPrompt({ toolNames: CHILD_TOOL_NAMES });
    for (const name of CHILD_TOOL_NAMES) {
      expect(text).toContain(name);
    }
    // The excluded names (delegate_task, spawn_session, memory) must never
    // leak into the tools sentence itself — checked against the one line
    // that names them, not the whole prompt (DOCTRINE_CORE/harness text are
    // free to mention "delegate" in prose elsewhere).
    const toolsLine = text
      .split("\n\n")
      .find((paragraph) => paragraph.startsWith("Tools available to you:"));
    expect(toolsLine).toBeDefined();
    for (const excluded of ["delegate_task", "spawn_session", "memory"]) {
      expect(toolsLine).not.toContain(excluded);
    }
  });

  // Issue #641 (épico #637, grupo F, item 21): a suíte acima só prova
  // presença/ausência — uma linha com um nome a mais ou em ordem diferente
  // passaria (veredito PR #615, non_blocking 4). Os dois testes abaixo
  // provam por igualdade: string inteira para uma lista fixa, e
  // conjunto+ordem exatos contra `childToolDefinitions` para a lista real.
  it("renders the tools paragraph as an exact string for a fixed tool list (#641)", () => {
    const text = buildSubagentSystemPrompt({ toolNames: ["read_file", "write_file", "terminal"] });
    const toolsParagraph = text
      .split("\n\n")
      .find((paragraph) => paragraph.startsWith("Tools available to you:"));
    expect(toolsParagraph).toBe(
      "Tools available to you: read_file, write_file, terminal — this is " +
        "the same tool array this turn actually offers, though a workflow " +
        "node forcing structured output can still append one more tool " +
        "definition to it beyond what's named here. Dangerous commands " +
        "(recursive delete, force push, sudo, and similar) are refused " +
        "automatically and finally here too, with no retry path around the " +
        "refusal.",
    );
  });

  it("names exactly the set and order childToolDefinitions produces, not just by presence (#641)", () => {
    const text = buildSubagentSystemPrompt({ toolNames: CHILD_TOOL_NAMES });
    const toolsParagraph = text
      .split("\n\n")
      .find((paragraph) => paragraph.startsWith("Tools available to you:"));
    expect(toolsParagraph).toBeDefined();
    const namesPart = (toolsParagraph ?? "")
      .slice("Tools available to you: ".length)
      .split(" — ")[0];
    expect((namesPart ?? "").split(", ")).toEqual([...CHILD_TOOL_NAMES]);
  });

  it("never claims an MCP tool parenthetical or a blanket refusal the runner does not honor (#641)", () => {
    const text = buildSubagentSystemPrompt({ toolNames: CHILD_TOOL_NAMES });
    expect(text).not.toContain("plus any MCP tools listed in this turn's own tool array");
    expect(text).not.toContain("any other tool name is refused");
  });

  it("carries the three-sentinel return contract, naming all of result:/failed:/needs input:", () => {
    const text = buildSubagentSystemPrompt({ toolNames: CHILD_TOOL_NAMES });
    expect(text).toContain('"result: <summary>"');
    expect(text).toContain('"failed: <why>"');
    expect(text).toContain('"needs input: <what>"');
  });

  it("says dangerous commands are refused automatically and finally", () => {
    const text = buildSubagentSystemPrompt({ toolNames: CHILD_TOOL_NAMES });
    expect(text).toMatch(/refused automatically and finally/);
  });

  it("says the task is the subagent's boundary and the parent cannot see raw tool output", () => {
    const text = buildSubagentSystemPrompt({ toolNames: CHILD_TOOL_NAMES });
    expect(text).toMatch(/your boundary/);
    expect(text).toMatch(/never sees your raw tool output/);
  });

  it("omits the Environment block when no cwd is given (byte-compat filter(Boolean) pattern)", () => {
    const text = buildSubagentSystemPrompt({ toolNames: CHILD_TOOL_NAMES });
    expect(text).not.toContain("Environment:");
  });

  it("omits the tools/contract block entirely when no toolNames are given", () => {
    const text = buildSubagentSystemPrompt({ cwd: "/work" });
    expect(text).not.toContain("Tools available to you:");
    expect(text).not.toContain("End your final message with exactly one line");
  });

  it("carries no memory, user-profile, or skills sections — a child has no access to those stores", () => {
    const text = buildSubagentSystemPrompt({ toolNames: CHILD_TOOL_NAMES, cwd: "/work" });
    expect(text).not.toContain("<memory>");
    expect(text).not.toContain("<user-profile>");
  });

  it("reuses buildSystemPrompt's own date default when no override is given, inheriting the pending T09 local-date fix automatically", () => {
    const viaShared = buildSystemPrompt({}).text.match(/Today's date is (.+)\.$/)?.[1];
    const viaSubagent = buildSubagentSystemPrompt().match(/Today's date is (.+)\.$/)?.[1];
    expect(viaSubagent).toBe(viaShared);
  });
});
