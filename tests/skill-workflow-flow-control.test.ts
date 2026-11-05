// Issue #979 (S2 do épico #976, desenho §9): a skill companheira
// `workflow-flow-control` — a doutrina dos blocos de controle de fluxo
// (`switch` hoje; `loop`, `escalate` e `call` nas issues seguintes), em
// `assets/skills/workflow-authoring/flow-control/SKILL.md`. O `SKILL.md`
// principal já está em 800 linhas pela contagem do teste, então ele só ganha
// um ponteiro, na mesma linha. Este arquivo é o anti-drift: os números e os
// nomes que a skill cita vêm do código (`MAX_SWITCH_CASES`, `NODE_SPECS`), de
// modo que mudar o limite sem mexer na skill reprova aqui.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseSkillMd, SkillStore } from "../src/skills/store.js";
import { MAX_SWITCH_CASES, NODE_SPECS, ROUTING_FIELDS } from "../src/workflow/nodes.js";

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
});
