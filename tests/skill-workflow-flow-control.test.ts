// Issue #979 (S2 do épico #976, desenho §9): a skill companheira
// `workflow-flow-control` — a doutrina dos blocos de controle de fluxo
// (`switch`, `loop` e `escalate` hoje; `call` na issue seguinte), em
// `assets/skills/workflow-authoring/flow-control/SKILL.md`. O `SKILL.md`
// principal já está em 800 linhas pela contagem do teste, então ele só ganha
// um ponteiro, na mesma linha. Este arquivo é o anti-drift: os números e os
// nomes que a skill cita vêm do código (`MAX_SWITCH_CASES`, `MAX_LOOP_ROUNDS`,
// `PREDICATE_NAMES`, `NODE_SPECS`), de modo que mudar o limite sem mexer na
// skill reprova aqui. Issue #980 (S3): a seção do `loop` e a tabela de
// predicados. Issue #981 (S4): a seção do `escalate`, o ponteiro do `SKILL.md`
// principal alargado para os quatro blocos e o motivo `escalated` na seção 6.
// Issue #982 (S6): a seção do `call`, com a allow-list, os limites e o formato do fault vindos
// do código (`CALL_TOOLS`, `MAX_CALL_ARGS`, `MAX_CALL_TIMEOUT_SECONDS`, `MAX_NODE_RETRIES`).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseSkillMd, SkillStore } from "../src/skills/store.js";
import { CALL_TOOLS, MAX_CALL_TIMEOUT_SECONDS } from "../src/workflow/call-tools.js";
import {
  ANSWER_NODE_TYPES,
  DEFAULT_CALL_TIMEOUT_SECONDS,
  ESCALATE_KIND,
  MAX_CALL_ARGS,
  MAX_ESCALATE_SUMMARY,
  MAX_LOOP_ROUNDS,
  MAX_NODE_RETRIES,
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
  const end = companion.indexOf("## 3. `escalate`");
  const section = companion.slice(start, end);
  const sectionFlat = section.replace(/\s+/gu, " ");

  it("has its own section, ahead of the escalate section", () => {
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
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    const types = blocks.flatMap((block) => {
      const result = validateSpec(JSON.parse(block ?? "null"));
      expect(result).toBeInstanceOf(WorkflowSpec);
      return (result as WorkflowSpec).nodes.map((node) => node.type);
    });
    expect(types).toContain("switch");
    expect(types).toContain("loop");
    expect(types).toContain("escalate");
    expect(types).toContain("call");
  });
});
describe("the escalate section matches the code (#981)", () => {
  const start = companion.indexOf("## 3. `escalate`");
  const end = companion.indexOf("## 4. `call`");
  const section = companion.slice(start, end);
  const sectionFlat = section.replace(/\s+/gu, " ");

  it("has its own section, between the loop and the call section", () => {
    expect(start).toBeGreaterThan(companion.indexOf("## 2. `loop`"));
    expect(end).toBeGreaterThan(start);
  });

  it("states the summary cap and the kind pattern that the code holds", () => {
    expect(sectionFlat).toContain(`1 to ${String(MAX_ESCALATE_SUMMARY)} characters`);
    expect(section).toContain(ESCALATE_KIND.source);
  });

  it("names every field of the node, and says the routing knobs and `default` are refused", () => {
    const spec = NODE_SPECS.escalate;
    expect(spec).toBeDefined();
    const own = (spec?.fields ?? []).filter((field) => !["required", "depends_on"].includes(field));
    expect(own.sort()).toEqual(["kind", "summary", "when"]);
    for (const field of own) expect(section).toContain(`\`${field}\``);
    for (const knob of ROUTING_FIELDS) expect(section).toContain(`\`${knob}\``);
    expect(section).toContain("`default`");
    expect(sectionFlat).toMatch(/no routing knobs?|refuses? (the )?routing knobs?/u);
  });

  it("states what the node returns, with and without the pause", () => {
    expect(section).toContain("{escalated: false}");
    expect(section).toContain("{escalated: true, kind, summary, answer}");
  });

  it("says how the pause reads: the reason, the escalation, the ledger and the answer channel", () => {
    expect(section).toContain("`escalated`");
    expect(section).toContain("`escalation`");
    expect(section).toContain("{node_id, kind, summary}");
    expect(section).toContain("node.paused");
    expect(section).toContain("checkpoint_answers");
    for (const type of ANSWER_NODE_TYPES) expect(section).toContain(`\`${type}\``);
  });

  it("says a resume without the answer is refused, and that nothing resumes the run on its own", () => {
    expect(sectionFlat).toMatch(/refused/u);
    expect(sectionFlat).toMatch(/lease/u);
    expect(sectionFlat).toMatch(/nothing resumes|never resumes/u);
  });

  it("explains the scoped id inside a nested workflow, as the checkpoint has it", () => {
    expect(section).toContain("<workflow node id>.<escalate id>");
    expect(sectionFlat).toMatch(/collid/u);
  });

  it("documents the failure modes: a dead upstream and a summary that is cut", () => {
    expect(sectionFlat).toContain("upstream null");
    expect(sectionFlat).toMatch(/cut|truncated/u);
    expect(section).toContain("…");
  });

  it("says it fails closed: a condition it cannot check, a summary it cannot write or that is blank, all pause", () => {
    expect(sectionFlat).toMatch(/fails? \*\*closed\*\*/u);
    expect(section).toContain("[condition not evaluated:");
    expect(section).toContain("[unrendered]");
    expect(section).toContain("[empty summary]");
    expect(section).toContain("no value for ${scan.reason}");
    expect(sectionFlat).toContain("summary rendered empty");
    expect(sectionFlat).toMatch(/held to be true/u);
    expect(sectionFlat).toMatch(/do not run/u);
    // the old promise, that a failure here lets the run go on, must be gone
    expect(sectionFlat).not.toMatch(/does \*\*not\*\* pause/u);
    expect(sectionFlat).not.toMatch(/the run does not pause/u);
  });

  it("says how a resume, the cell and the preview behave", () => {
    expect(sectionFlat).toMatch(/never asks again/u);
    expect(sectionFlat).toMatch(/new question|different question/u);
    expect(section).toContain("escalation_pending");
    expect(section).toContain("no_leaves");
  });

  it("says when to use a checkpoint instead", () => {
    expect(sectionFlat).toMatch(/always (stops|pauses)/u);
    expect(section).toContain("`checkpoint`");
  });

  it("the skill's description offers it", () => {
    expect(parseSkillMd(companion).description).toContain("escalate");
  });
});

describe("the call section matches the code (#982)", () => {
  const start = companion.indexOf("## 4. `call`");
  const end = companion.indexOf("## 5. Checklist");
  const section = companion.slice(start, end);
  const sectionFlat = section.replace(/\s+/gu, " ");

  it("has its own section, between the escalate section and the checklist", () => {
    expect(start).toBeGreaterThan(companion.indexOf("## 3. `escalate`"));
    expect(end).toBeGreaterThan(start);
  });

  it("names every tool the allow-list has, and the ones that stay out", () => {
    for (const tool of CALL_TOOLS) expect(section).toContain(`\`${tool}\``);
    for (const tool of ["web_search", "write_file", "terminal"])
      expect(section, tool).toContain(`\`${tool}\``);
    expect(sectionFlat).toMatch(/not allowed|are refused|stay out|left out/u);
  });

  it("states the limits that the code holds: the args, the deadline and the retries", () => {
    expect(sectionFlat).toContain(`up to ${String(MAX_CALL_ARGS)} keys`);
    expect(sectionFlat).toContain(`at most ${String(MAX_CALL_TIMEOUT_SECONDS)} seconds`);
    expect(sectionFlat).toContain(`${String(DEFAULT_CALL_TIMEOUT_SECONDS)} seconds`);
    expect(sectionFlat).toContain(`0 to ${String(MAX_NODE_RETRIES)} retries`);
  });

  it("names every field of the node, and says there are no routing knobs", () => {
    const spec = NODE_SPECS.call;
    expect(spec).toBeDefined();
    const own = (spec?.fields ?? []).filter((field) => !["required", "depends_on"].includes(field));
    expect(own.sort()).toEqual(["args", "retries", "timeout", "tool"]);
    for (const field of own) expect(section).toContain(`\`${field}\``);
    for (const knob of ROUTING_FIELDS) expect(section).toContain(`\`${knob}\``);
    expect(sectionFlat).toMatch(/no routing knobs?|refuses? (the )?routing knobs?/u);
  });

  it("says what a later node reads: the tool's own envelope, field by field", () => {
    for (const field of ["ok", "data", "truncated", "text", "untrusted"])
      expect(section, field).toContain(`\`${field}\``);
    expect(section).toContain("${fetch.text}");
    expect(sectionFlat).toMatch(/envelope/u);
  });

  it("says it costs no model: no leaf, no token, nothing in the per-node cost", () => {
    expect(sectionFlat).toMatch(/no leaf/u);
    expect(sectionFlat).toMatch(/no tokens?/u);
    expect(sectionFlat).toContain("per-node cost");
  });

  it("says each attempt is charged to the run's limits, and what a refusal looks like", () => {
    expect(sectionFlat).toMatch(/each attempt/u);
    expect(sectionFlat).toContain("cap_trips");
    expect(sectionFlat).toContain("lifetime");
  });

  it("says which outcomes are retried and which never are", () => {
    expect(sectionFlat).toMatch(/`error` and `timeout`[^.]*retried/u);
    expect(sectionFlat).toMatch(/`denied`[^.]*never retried/u);
  });

  it("documents the failure modes: the fault format, a dead upstream, a missing port and a stopped run", () => {
    expect(section).toContain("<id>: call <tool> <status> after <n> attempts: <cause>");
    expect(sectionFlat).toContain("upstream null");
    expect(sectionFlat).toContain("no value for");
    expect(sectionFlat).toContain("engine fault");
    expect(sectionFlat).toMatch(/stopped|paused or cancelled/u);
    expect(sectionFlat).toMatch(/before any call/u);
  });

  it("says it goes through the same sandbox as a leaf, and what the policy limits", () => {
    expect(section).toContain("workflow_policy.json");
    expect(section).toContain("fs_allow");
    expect(section).toContain("egress_allow");
    expect(sectionFlat).toMatch(/same sandbox/u);
  });

  it("says what the ledger shows: tool.started and tool.completed, and no leaf", () => {
    expect(section).toContain("tool.started");
    expect(section).toContain("tool.completed");
    expect(section).toContain("leaf.started");
  });

  it("says how a resume, the cell and the preview behave", () => {
    expect(sectionFlat).toMatch(/not called again|never called again/u);
    expect(sectionFlat).toMatch(/`timeout` and `retries` are not part of the cell/u);
    expect(sectionFlat).toMatch(/failed call leaves no cell/u);
    expect(section).toContain("would_call");
    expect(section).toContain("leaves_to_spawn");
  });

  it("says when not to use it: a page that needs judgement is a leaf, a write is a leaf", () => {
    expect(sectionFlat).toMatch(/needs? judg(e)?ment|has to be read/u);
    expect(section).toContain("`agent`");
  });

  it("the skill's description offers it, and the checklist has a list for it", () => {
    expect(parseSkillMd(companion).description).toContain("call");
    expect(companion.slice(end)).toContain("For a `call`:");
  });
});

describe("workflow-authoring points at all four blocks and documents the new pause (#981)", () => {
  const pointer = main.split("\n").find((line) => line.includes("workflow-flow-control")) ?? "";

  it("the pointer names the companion skill and the four nodes it covers", () => {
    expect(pointer).not.toBe("");
    for (const node of ["switch", "loop", "escalate", "call"])
      expect(pointer, node).toContain(`\`${node}\``);
  });

  it("the pause reasons list the `escalated` one, and the preview list the new outcome", () => {
    expect(main).toMatch(/\*\*`escalated`\*\*/u);
    expect(main).toContain("escalation_pending");
  });
});
