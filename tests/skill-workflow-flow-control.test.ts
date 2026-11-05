// Issue #979 (S2 do épico #976, desenho §9): a skill companheira
// `workflow-flow-control` — a doutrina dos blocos de controle de fluxo
// (`switch` e `loop` hoje; `escalate` e `call` nas issues seguintes), em
// `assets/skills/workflow-authoring/flow-control/SKILL.md`. O `SKILL.md`
// principal já está em 800 linhas pela contagem do teste, então ele só ganha
// um ponteiro, na mesma linha. Este arquivo é o anti-drift: os números e os
// nomes que a skill cita vêm do código (`MAX_SWITCH_CASES`, `MAX_LOOP_ROUNDS`,
// `PREDICATE_NAMES`, `NODE_SPECS`), de modo que mudar o limite sem mexer na
// skill reprova aqui. Issue #980 (S3): a seção do `loop` e a tabela de
// predicados.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseSkillMd, SkillStore } from "../src/skills/store.js";
import {
  MAX_LOOP_ROUNDS,
  MAX_SWITCH_CASES,
  NODE_SPECS,
  ROUTING_FIELDS,
} from "../src/workflow/nodes.js";
import {
  MAX_PREDICATE_VALUES,
  PREDICATE_NAMES,
  PREDICATE_TYPES,
} from "../src/workflow/predicates.js";
import { validateSpec } from "../src/workflow/schema.js";
import { WorkflowSpec } from "../src/workflow/types.js";

const root = resolve(import.meta.dirname, "..");
const builtinRoot = resolve(root, "assets/skills/workflow-authoring");
const read = (path: string): string => readFileSync(resolve(builtinRoot, path), "utf8");

const companion = read("flow-control/SKILL.md");
const main = read("SKILL.md");
const flat = companion.replace(/\s+/gu, " ");

/** The line count the repo's convention test uses (`split("\n").length`). */
const lineCount = (text: string): number => text.split("\n").length;

describe("workflow-flow-control: the companion skill exists and is loadable (#979)", () => {
  it("parses, is named workflow-flow-control, and has a trigger and an anti-trigger", () => {
    const skill = parseSkillMd(companion);
    expect(skill.name).toBe("workflow-flow-control");
    expect(skill.version).not.toBe("");
    expect(skill.description).toContain("switch");
    expect(skill.description).toContain("loop");
    expect(skill.description).toMatch(/Do NOT/u);
  });

  it("is found by the SkillStore through the builtin root, next to workflow-authoring", () => {
    const home = mkdtempSync(join(tmpdir(), "lohra-skills-flow-"));
    try {
      const names = new SkillStore(home, [], [builtinRoot]).scan().map((skill) => skill.name);
      expect(names).toContain("workflow-flow-control");
      expect(names).toContain("workflow-authoring");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stays inside the 800-line convention", () => {
    expect(lineCount(companion)).toBeLessThanOrEqual(800);
  });
});

describe("workflow-authoring points at it without growing (#979)", () => {
  it("names the companion skill", () => {
    expect(main).toContain("workflow-flow-control");
  });

  it("is still within 800 lines by the test's own count", () => {
    expect(lineCount(main)).toBeLessThanOrEqual(800);
  });
});

describe("the switch section matches the code (#979)", () => {
  it("states the case cap that MAX_SWITCH_CASES holds", () => {
    expect(flat).toContain(`2 to ${String(MAX_SWITCH_CASES)} cases`);
  });

  it("names every field of the node: the ones it owns and the routing knobs", () => {
    const spec = NODE_SPECS.switch;
    expect(spec).toBeDefined();
    const own = (spec?.fields ?? []).filter(
      (field) => !["required", "depends_on", ...ROUTING_FIELDS].includes(field),
    );
    expect(own.sort()).toEqual(["cases", "otherwise", "value"]);
    for (const field of own) expect(companion).toContain(`\`${field}\``);
    for (const knob of ROUTING_FIELDS) expect(companion).toContain(`\`${knob}\``);
  });

  it("states what the node returns and the role its leaf carries", () => {
    expect(companion).toContain("{case, matched, output}");
    expect(companion).toContain("`switch.case`");
    expect(companion).toContain("`item_index`");
  });

  it("documents the failure modes: no match, a dead upstream, and a null case", () => {
    expect(flat).toMatch(/no case matches/u);
    expect(flat).toContain("upstream null");
    expect(flat).toMatch(/`null` case/u);
    expect(flat).toMatch(/`matched: false`|`matched:false`/u);
  });

  it("says a resume re-reads the value and that routing goes on the node, not in a case", () => {
    expect(flat).toContain("identity_changed");
    expect(flat).toMatch(/routing knobs? .{0,40}(on the node|node level)/u);
  });

  it("names the preview outcome for a null case", () => {
    expect(companion).toContain("no_leaves");
  });

  it("its worked example is a spec the validator accepts, so it cannot drift from the schema", () => {
    const block = /```json\n([\s\S]*?)\n```/u.exec(companion)?.[1];
    expect(block, "the skill should carry a ```json example").toBeDefined();
    const result = validateSpec(JSON.parse(block ?? "null"));
    expect(result).toBeInstanceOf(WorkflowSpec);
    const nodes = (result as WorkflowSpec).nodes;
    expect(nodes.map((node) => node.type)).toEqual(["agent", "switch"]);
  });
});

describe("the loop section matches the code (#980)", () => {
  const start = companion.indexOf("## 2. `loop`");
  const end = companion.indexOf("## 3. Checklist");
  const section = companion.slice(start, end);
  const sectionFlat = section.replace(/\s+/gu, " ");

  it("has its own section, ahead of the checklist", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("states the round cap that MAX_LOOP_ROUNDS holds, and that it is mandatory", () => {
    expect(sectionFlat).toContain(`1 to ${String(MAX_LOOP_ROUNDS)} rounds`);
    expect(sectionFlat).toMatch(/`max_rounds`[^.]*(required|mandatory)/u);
  });

  it("names every field of the node: the ones it owns and the routing knobs", () => {
    const spec = NODE_SPECS.loop;
    expect(spec).toBeDefined();
    const own = (spec?.fields ?? []).filter(
      (field) => !["required", "depends_on", ...ROUTING_FIELDS].includes(field),
    );
    expect(own.sort()).toEqual(["body", "max_rounds", "until"]);
    for (const field of own) expect(section).toContain(`\`${field}\``);
    for (const knob of ROUTING_FIELDS) expect(section).toContain(`\`${knob}\``);
  });

  it("has a predicate table with one row per predicate the validator accepts", () => {
    for (const name of PREDICATE_NAMES)
      expect(section, `predicate ${name}`).toMatch(new RegExp(`^\\| \`${name}\``, "mu"));
    expect(sectionFlat).toContain(`1 to ${String(MAX_PREDICATE_VALUES)}`);
    for (const type of PREDICATE_TYPES) expect(section).toContain(`\`${type}\``);
  });

  it("explains the locals: round and so_far in the body, last only in until", () => {
    for (const local of ["round", "so_far", "last"]) expect(section).toContain(`\${${local}`);
    expect(sectionFlat).toMatch(/`last`[^.]*only[^.]*`until`/u);
  });

  it("states what the node returns and the role of the leaf of each round", () => {
    expect(section).toContain("{last, rounds, until_met}");
    expect(section).toContain("`loop.round`");
    expect(section).toContain("`until_met: true`");
    expect(section).toContain("`until_met: false`");
  });

  it("documents the failure modes: the cap, a dead round, a dead upstream and an empty answer", () => {
    expect(sectionFlat).toContain("reached max_rounds");
    expect(sectionFlat).toContain("round <n> dead");
    expect(sectionFlat).toContain("upstream null");
    expect(sectionFlat).toMatch(/empty output/u);
  });

  it("says how a resume, the fan-out cap and the progress behave", () => {
    expect(sectionFlat).toMatch(/one cell per round/u);
    expect(sectionFlat).toMatch(/continues from the round/u);
    expect(section).toContain("cache.replayed");
    expect(sectionFlat).toMatch(/fan-out[^.]*`max_rounds`|`max_rounds`[^.]*fan-out/u);
    expect(section).toContain("items");
  });

  it("says when to use loop_until_dry instead", () => {
    expect(section).toContain("loop_until_dry");
  });

  it("every ```json example in the skill is a spec the validator accepts", () => {
    const blocks = [...companion.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => match[1]);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const types = blocks.flatMap((block) => {
      const result = validateSpec(JSON.parse(block ?? "null"));
      expect(result).toBeInstanceOf(WorkflowSpec);
      return (result as WorkflowSpec).nodes.map((node) => node.type);
    });
    expect(types).toContain("switch");
    expect(types).toContain("loop");
  });
});
