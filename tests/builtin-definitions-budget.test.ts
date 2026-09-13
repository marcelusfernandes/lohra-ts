// Issue #585 (épico #575, P9): dieta do catálogo de tools. As 29 definições
// (`src/tools/builtin-definitions.ts`) eram reenviadas inteiras a cada
// iteração do runtime (`src/conversation/runtime.ts:485-497`) — 43.951 chars
// de JSON, ~18k tokens pela regra de 2,4 chars/token do próprio runtime
// (`src/context/token-estimate.ts`), com as 12 tools de workflow sozinhas em
// 72% disso e `run_workflow` reenviando um manual que já mora na skill
// `workflow-authoring`. Este arquivo prende:
//   1. o orçamento do catálogo inteiro;
//   2. que `run_workflow` mantém a lista fechada de 10 node types e o
//      ponteiro para a skill, sem o manual (exemplo de spec, glossário de
//      campos) que agora só vive lá;
//   3. o padrão prescritivo (quando usar / quando não / limite) nas sete
//      tools básicas (`read_file`, `write_file`, `terminal`, `web_fetch`,
//      `web_search`, `session_search`, `skill_view`);
//   4. que o manual movido ganhou seção própria em
//      `assets/skills/workflow-authoring/SKILL.md`.
// O contrato estrutural (ordem, `name`, schemas de parâmetros sem
// `description`) é responsabilidade de `tests/tools-core.test.ts`; os quatro
// testes de substring pré-existentes continuam prendendo o comportamento que
// já protegiam.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BUILTIN_DEFINITIONS } from "../src/tools/builtin-definitions.js";

const CATALOG_BUDGET_CHARS = 22_000;

function findTool(name: string): (typeof BUILTIN_DEFINITIONS)[number] {
  const tool = BUILTIN_DEFINITIONS.find((definition) => definition.function.name === name);
  if (tool === undefined) throw new Error(`tool '${name}' not found in BUILTIN_DEFINITIONS`);
  return tool;
}

function descriptionOf(name: string): string {
  return findTool(name).function.description;
}

describe("BUILTIN_DEFINITIONS token budget (#585)", () => {
  it(`stays at or under ${String(CATALOG_BUDGET_CHARS)} chars of JSON`, () => {
    const size = JSON.stringify(BUILTIN_DEFINITIONS).length;
    expect(size).toBeLessThanOrEqual(CATALOG_BUDGET_CHARS);
  });
});

describe("run_workflow: closed node list and skill pointer survive the diet (#585)", () => {
  const description = (): string => descriptionOf("run_workflow");

  it("still names the closed set of 10 node types", () => {
    const nodeTypes = [
      "agent",
      "parallel",
      "pipeline",
      "loop_until_dry",
      "verify",
      "judge_panel",
      "workflow",
      "gate",
      "completeness_check",
      "checkpoint",
    ];
    for (const nodeType of nodeTypes) {
      expect(description()).toContain(nodeType);
    }
  });

  it("still points at the workflow-authoring skill before authoring", () => {
    expect(description()).toMatch(/workflow-authoring skill/);
  });

  it("no longer carries the full spec example (moved to the skill)", () => {
    expect(description()).not.toContain("triage-bugs");
  });

  it("is far shorter than the pre-diet 8,157-char manual", () => {
    expect(description().length).toBeLessThan(2500);
  });
});

describe("basic tools: when-to-use / when-not / limit pattern (#585)", () => {
  it("read_file: limit and preference over terminal", () => {
    const d = descriptionOf("read_file");
    expect(d).toContain("100,000 code points");
    expect(d).toContain("terminal");
    expect(d).toMatch(/not for/i);
  });

  it("write_file: overwrite semantics and no size cap", () => {
    const d = descriptionOf("write_file");
    expect(d).toMatch(/overwrite/i);
    expect(d).toContain("terminal");
    expect(d).toMatch(/no size limit/i);
  });

  it("terminal: output cap and preference for read_file", () => {
    const d = descriptionOf("terminal");
    expect(d).toContain("50,000 code points");
    expect(d).toContain("read_file");
  });

  it("web_fetch: extraction limit and it is not a search tool", () => {
    const d = descriptionOf("web_fetch");
    expect(d).toContain("20,000 chars");
    expect(d).toMatch(/not a search tool/i);
  });

  it("web_search: result cap and the follow-up with web_fetch", () => {
    const d = descriptionOf("web_search");
    expect(d).toMatch(/10 results/);
    expect(d).toContain("web_fetch");
  });

  it("session_search: scoped away from the live conversation and the web", () => {
    const d = descriptionOf("session_search");
    expect(d).toMatch(/never the current conversation/i);
    expect(d).toMatch(/never the web/i);
  });

  it("skill_view: don't call it speculatively, no size limit", () => {
    const d = descriptionOf("skill_view");
    expect(d).toMatch(/speculatively/i);
    expect(d).toMatch(/no size limit/i);
  });
});

describe("workflow-authoring skill absorbed the manual moved out of descriptions (#585)", () => {
  const skill = readFileSync(
    resolve(import.meta.dirname, "../assets/skills/workflow-authoring/SKILL.md"),
    "utf8",
  );

  it("documents live_tail (moved out of workflow_status)", () => {
    expect(skill).toContain("live_tail");
  });

  it("documents the rename_hint checkpoint collision (moved out of workflow_status)", () => {
    expect(skill).toContain("rename_hint");
  });

  it("documents workflow_leaf_read and workflow_steer (previously undocumented anywhere)", () => {
    expect(skill).toContain("workflow_leaf_read");
    expect(skill).toContain("workflow_steer");
  });

  it("documents the audit trail's integrity.pending scope (moved out of workflow_audit)", () => {
    expect(skill).toContain("integrity.pending");
  });

  it("stays within the repo's file-size convention (800 lines)", () => {
    const lines = skill.split("\n").length;
    expect(lines).toBeLessThanOrEqual(800);
  });
});
