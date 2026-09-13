// Issue #582 (épico #575, P6): contrato anti-drift no padrão do Python
// (`test_memory_guidance_taxonomy.py`, portado de `backend/lohra/memory/
// tool.py` e `backend/lohra/skills/tool.py`) — as descriptions de `memory`
// e `skill_manage` (`BUILTIN_DEFINITIONS`) classificam uma falha por
// causa (agência x ambiente, decision note #54) antes de decidir se ela
// merece memória ou skill, e nunca convidam o enquadramento "environment
// quirk" sem essa qualificação.
import { describe, expect, it } from "vitest";

import { BUILTIN_DEFINITIONS } from "../src/tools/builtin-definitions.js";

function descriptionOf(name: string): string {
  const tool = BUILTIN_DEFINITIONS.find((definition) => definition.function.name === name);
  if (tool === undefined) throw new Error(`tool '${name}' not found in BUILTIN_DEFINITIONS`);
  return tool.function.description;
}

describe("memory tool guidance taxonomy (#582)", () => {
  const guidance = (): string => descriptionOf("memory");

  it("does not invite unqualified 'environment quirk' framing", () => {
    expect(guidance()).not.toContain("environment quirk");
  });

  it("names the agency class with a concrete example", () => {
    expect(guidance()).toContain("agency");
    expect(guidance()).toMatch(/model.*(does not exist|doesn't exist)/);
  });

  it("names the environment class with a concrete example", () => {
    expect(guidance()).toContain("environment");
    expect(guidance()).toMatch(/quota|timeout/);
  });

  it("defaults to agency without evidence of environment", () => {
    const lower = guidance().toLowerCase();
    expect(lower).toContain("agency");
    expect(lower).toMatch(/no evidence|without evidence/);
  });

  it("still forbids task progress and TODOs, pointing at skills instead", () => {
    expect(guidance()).toContain("task progress");
    expect(guidance()).toContain("TODOs");
    expect(guidance()).toContain("skills");
  });

  it("still requires declarative facts, not instructions to self", () => {
    expect(guidance()).toMatch(/declarative facts/i);
    expect(guidance()).toContain("not instructions to yourself");
  });
});

describe("skill_manage guidance taxonomy (#582)", () => {
  const guidance = (): string => descriptionOf("skill_manage");

  it("does not invite unqualified 'environment quirk' framing", () => {
    expect(guidance()).not.toContain("environment quirk");
  });

  it("classifies an error workaround as agency (fix it, don't skill it) or environment (worth a skill)", () => {
    expect(guidance()).toContain("agency");
    expect(guidance()).toContain("environment");
    expect(guidance()).toMatch(/model.*(does not exist|doesn't exist)/);
    expect(guidance()).toMatch(/quota|timeout/);
  });

  it("defaults to agency without evidence of environment", () => {
    const lower = guidance().toLowerCase();
    expect(lower).toContain("agency");
    expect(lower).toMatch(/no evidence|without evidence/);
  });

  it("still keeps create/update/delete and scope='project' guidance", () => {
    expect(guidance()).toContain("update a stale one");
    expect(guidance()).toContain("delete removes one (home only)");
    expect(guidance()).toContain("scope='project'");
  });
});
