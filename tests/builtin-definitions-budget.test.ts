// Issue #585 (épico #575, P9): dieta do catálogo de tools. As 29 definições
// (`src/tools/builtin-definitions.ts`) eram reenviadas inteiras a cada
// iteração do runtime (`src/conversation/runtime.ts:485-497`) — 43.951 chars
// de JSON, ~18k tokens pela regra de 2,4 chars/token do próprio runtime
// (`src/context/token-estimate.ts`), com as 12 tools de workflow sozinhas em
// 72% disso e `run_workflow` reenviando um manual que já mora na skill
// `workflow-authoring`. Este arquivo prende:
//   1. o orçamento do catálogo inteiro;
//   2. o contrato estrutural: ordem e `name` das 29 tools intocados, e os
//      schemas de `parameters` byte-idênticos aos de antes da dieta (só a
//      chave `description` pode mudar) — checado por hash SHA-256 de
//      `JSON.stringify(parameters)` por tool, não pelo texto completo, para
//      não duplicar o catálogo inteiro dentro do teste;
//   3. que `run_workflow` mantém a lista fechada de 10 node types e o
//      ponteiro para a skill, sem o manual (exemplo de spec, glossário de
//      campos) que agora só vive lá;
//   4. o padrão prescritivo (quando usar / quando não / limite) nas sete
//      tools básicas (`read_file`, `write_file`, `terminal`, `web_fetch`,
//      `web_search`, `session_search`, `skill_view`);
//   5. que o manual movido ganhou seção própria em
//      `assets/skills/workflow-authoring/SKILL.md`.
// Os quatro testes de substring pré-existentes
// (`tests/builtin-definitions-audit-description.test.ts`,
// `tests/workflow-campos-sem-efeito.test.ts`, `tests/workflow-sandbox.test.ts`,
// `tests/workflow-checkpoint-aninhado.test.ts`) continuam prendendo o
// comportamento que já protegiam.
import { createHash } from "node:crypto";
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

function parametersHash(name: string): string {
  return createHash("sha256")
    .update(JSON.stringify(findTool(name).function.parameters))
    .digest("hex");
}

// Ordem e `name`, capturados do catálogo ANTES da dieta (#585) — a issue
// exige que a dieta nunca reordene nem renomeie uma tool.
const PRE_DIET_NAMES = [
  "read_file",
  "write_file",
  "terminal",
  "web_fetch",
  "web_search",
  "memory",
  "skill_view",
  "skill_manage",
  "session_search",
  "delegate_task",
  "cronjob",
  "vision_analyze",
  "image_gen",
  "spawn_session",
  "steer_session",
  "collect_session",
  "run_workflow",
  "workflow_status",
  "workflow_list",
  "workflow_pause",
  "workflow_cancel",
  "workflow_templates",
  "workflow_audit",
  "workflow_notices",
  "workflow_notices_ack",
  "list_models",
  "workflow_leaf_read",
  "workflow_steer",
  "workflow_preview",
] as const;

// Hash SHA-256 de `JSON.stringify(function.parameters)` por tool, capturado
// ANTES da dieta — a dieta só pode encolher `description`, nunca o schema.
const PRE_DIET_PARAMETERS_HASH: Record<(typeof PRE_DIET_NAMES)[number], string> = {
  read_file: "2d68d8605e4ed371ab19e8c65b66a3ceb82d7a49e38d7629f7c9cb925a94063a",
  write_file: "bb3e9d7f462cfeef963ff9ad6431f86c31fbae2edd3824bc597d9ae1b4b72919",
  terminal: "4abf1660dc4301f50958c4c8b643d3c1606b85e0a14cbca123874ab86142a074",
  web_fetch: "0d9a1a0dc9f0531544a18ae4a62f2d91bdbdbb9c68bcf3856aa42410944a59de",
  web_search: "3521dc6809220db2daa18c600fe4f7c2388d609f7642403e3fbf4845cd7bf0ed",
  memory: "2de4b855f81f0b39627acaa6df2cac16391a3a31841945b822790e68c5bc4805",
  skill_view: "c7690942abdb177df5afa926129f417213813c956263b8e6d31865cecfefaae8",
  skill_manage: "60288cd68e8758eb2540b9be3b9a511ebe95f87089d3e0febeb91220b65fe1d4",
  session_search: "ae001ea0be13da9acf1536085fadb808e02c245c2a842d0d55fa95b32ee392f5",
  delegate_task: "3b4b26c3fbb029a7b9ad9a84445317f279b1d6dfa2822a1c800c969e66fd87bf",
  cronjob: "79837eebbd97ec21650b6d3043a10410853c0020925a86fdbefbcfdc45233be8",
  vision_analyze: "008bd6b9de3899fa6bd1f6d3ba1b895a66d2a8241214ca77df6f4d9cc2d457f8",
  image_gen: "a75f3591f099a2a20e175eac7ef91002f7e2bc1ecd4b5b434530ffb65585e322",
  spawn_session: "d276d907eab47a6089b912230b38c3fab1df253866c927103cfb5ff50c9cb6ca",
  steer_session: "d8f9cf9d98a06340bd1c21e3f2fb262ad3b38fc7a56e5d54ce683ae09b8130db",
  collect_session: "82c248236313a962fa02c24bac2ce64f2660cd605b3e618c329f76df05a295f1",
  run_workflow: "902b6770847d714d3b20c04591d4cd43d3f9561f4a29a69d583a0db225b7cc08",
  workflow_status: "4d792c11305edb0fe22443a5428e1946ca966d393e79f9ec0c392ccb570ac6ae",
  workflow_list: "8243f0af367f188a376f2c17b5eabe872a2f7a979813e0d4e2be6d594c2aa259",
  workflow_pause: "dffb37dbcca421f16f632f20a90caa589da2fcf7de07ece11dddd990780a30b8",
  workflow_cancel: "dffb37dbcca421f16f632f20a90caa589da2fcf7de07ece11dddd990780a30b8",
  workflow_templates: "341b995240d78980755baab674a906d1b47ce661a39d269d5ba7df37c776f0de",
  workflow_audit: "71bb9fc3f55b45ffb960402074a48dcbf2e91db11b1207cb297cd91d288d8cbd",
  workflow_notices: "d33c6de189a37752cca3394fd5b4245ee37103ada924f884dfb0f2a72486b6af",
  workflow_notices_ack: "5385069f94da461a8e8ee2989ea749e5da54c4bd8fce4695e5fb4c315534d0aa",
  list_models: "bb38b0f33c09a0ff7c87a54cb0b95fd89dc844292296a9c7470577c52d8fcd23",
  workflow_leaf_read: "a9a1960f61cf17504f74a04f42fe04f506e3d72115058d6564063b8061603d5d",
  workflow_steer: "0e688bef084baa114dc4928a33724f5fa206f43a1585089cc349a54f41e04bf5",
  workflow_preview: "f5269e11d7d1c3e51a88b8047a81e2f63b31692baeeb94ce83229522463c0bd6",
};

describe("BUILTIN_DEFINITIONS structural contract (#585)", () => {
  it("keeps declaration order and every name unchanged by the diet", () => {
    expect(BUILTIN_DEFINITIONS.map((definition) => definition.function.name)).toEqual([
      ...PRE_DIET_NAMES,
    ]);
  });

  it("keeps every parameters schema byte-identical (hash) — only description may shrink", () => {
    for (const name of PRE_DIET_NAMES) {
      expect(parametersHash(name), `parameters schema of '${name}' changed`).toBe(
        PRE_DIET_PARAMETERS_HASH[name],
      );
    }
  });

  it("keeps the function key order (description, parameters, name)", () => {
    for (const name of PRE_DIET_NAMES) {
      expect(Object.keys(findTool(name).function)).toEqual(["description", "parameters", "name"]);
    }
  });
});

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

// Rodada 2 (revisor, PR #598): sandbox_refusals é regra de comportamento
// (o modelo precisa saber que não flipa `status` sozinho), não manual — tem
// que continuar na description, não só na skill.
describe("workflow_status: sandbox_refusals advisory clause survives the diet (#585)", () => {
  it("still says sandbox_refusals is advisory and never flips status from complete on its own", () => {
    const d = descriptionOf("workflow_status");
    expect(d).toContain("sandbox_refusals");
    expect(d).toMatch(/ADVISORY|advisory/);
    expect(d).toMatch(/never.*flips.*status/i);
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

  it("session_search: scoped to other sessions, not the web", () => {
    const d = descriptionOf("session_search");
    expect(d).toMatch(/other sessions/i);
    expect(d).toMatch(/not (the )?web/i);
  });

  it("skill_view: only after the index flags it relevant, full body, no size limit", () => {
    const d = descriptionOf("skill_view");
    expect(d).toMatch(/index/i);
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

  // Rodada 2 (revisor, PR #598): sandbox_refusals/fault_kinds/partial_leaves/
  // usage_uncertain_leaves saíram da description de workflow_status sem
  // ganhar destino — nem na skill, nem em outra description. O modelo não lê
  // docs, então "glossed in the workflow-authoring skill" só é verdade se a
  // skill de fato contiver os quatro nomes.
  it("documents fault_kinds, partial_leaves and usage_uncertain_leaves (moved out of workflow_status)", () => {
    expect(skill).toContain("fault_kinds");
    expect(skill).toContain("partial_leaves");
    expect(skill).toContain("usage_uncertain_leaves");
  });

  it("stays within the repo's file-size convention (800 lines)", () => {
    const lines = skill.split("\n").length;
    expect(lines).toBeLessThanOrEqual(800);
  });
});

// Issue #605 (épico #575, follow-up dos vereditos r1/r2 da PR #598): cinco
// regras que a dieta do catálogo (#585) deixou sem destino — nem na
// description que o modelo lê, nem na skill. Cada `it` abaixo prende UMA.
describe("cronjob: consent trigger for autonomous spend survives the diet (#605)", () => {
  it("says the scheduled work is something the user asked to automate", () => {
    const d = descriptionOf("cronjob");
    expect(d).toMatch(/user asked (for|to automate)/i);
  });
});

describe("workflow-authoring skill: sandbox_refusals definition and cross-resume total (#605)", () => {
  const skill = readFileSync(
    resolve(import.meta.dirname, "../assets/skills/workflow-authoring/SKILL.md"),
    "utf8",
  );

  it("names the sandbox denial reasons: scope, read-only root, egress allowlist, tainted", () => {
    expect(skill).toMatch(/working scope/i);
    expect(skill).toMatch(/read-only root/i);
    expect(skill).toMatch(/egress\s+allowlist/i);
    expect(skill).toMatch(/run is tainted/i);
  });

  it("says sandbox_refusals stays the run's total across a resume", () => {
    expect(skill).toMatch(/run's total across (every|a) resume/i);
  });
});

describe("workflow-authoring skill: route knob refusal one level down is pinned (#238, #605)", () => {
  const skill = readFileSync(
    resolve(import.meta.dirname, "../assets/skills/workflow-authoring/SKILL.md"),
    "utf8",
  );

  it("says a routing knob inside body/synthesize/branches is refused at validation as an unknown field", () => {
    expect(skill).toMatch(/body[\s\S]{0,40}synthesize[\s\S]{0,40}branches/);
    expect(skill).toContain("refused at validation");
    expect(skill).toContain("unknown field");
  });
});

describe("workflow-authoring skill: audit.gap, filter semantics, preview outcomes, fault order (#605)", () => {
  const skill = readFileSync(
    resolve(import.meta.dirname, "../assets/skills/workflow-authoring/SKILL.md"),
    "utf8",
  );

  it("documents audit.gap's sink_failure/process_crash reasons", () => {
    expect(skill).toContain("audit.gap");
    expect(skill).toContain("sink_failure");
    expect(skill).toContain("process_crash");
  });

  it("documents empty-string/zero-as-no-filter semantics for workflow_audit and workflow_notices", () => {
    expect(skill).toMatch(/no filter/i);
    expect(skill).toContain("workflow_audit");
    expect(skill).toContain("workflow_notices");
  });

  it("documents workflow_preview outcomes beyond replay/recompute", () => {
    expect(skill).toContain("checkpoint_pending");
    expect(skill).toContain("upstream_missing");
    expect(skill).toContain("no_leaves");
    expect(skill).toContain("token_budget_exhausted");
  });

  it("documents fault_kinds listing each leaf's ErrorKind in order of occurrence", () => {
    expect(skill).toContain("ErrorKind");
    expect(skill).toMatch(/order the failures occurred|order of occurrence/i);
  });
});
