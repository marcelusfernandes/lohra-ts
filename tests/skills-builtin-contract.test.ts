// Issue #590 (épico #575, P14): `assets/skills/use-lohra` descrevia o Lohra
// **Python** (nenhuma menção a `lohra-ts`) e nem essa skill nem
// `workflow-authoring` diziam quando NÃO carregar — a description é o único
// gatilho que um harness (Claude Code, Codex) enxerga antes de gastar tokens
// no corpo inteiro. Este contrato prende três fatos:
//
//   1. `use-lohra-ts` existe, cita `lohra-ts` literalmente, e toda flag que
//      cita (span em crase `--algo`) existe de fato em algum `*_SPEC` de
//      `src/cli/arg-spec.ts` — nenhuma flag inventada ou herdada do Python.
//   2. As descriptions de `use-lohra-ts` e `workflow-authoring` (as duas
//      skills que este runtime embute ou exporta) têm gatilho E
//      anti-gatilho ("Do NOT" + a situação a evitar).
//   3. `use-lohra` (a skill do Python) fica marcada como legado — não é
//      apagada (outro dono, `docs/decisions/2026-09-10-skills-harness.md`),
//      mas description e corpo dizem para não carregá-la para lohra-ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as argSpec from "../src/cli/arg-spec.js";
import type { CommandSpec } from "../src/cli/arg-spec.js";
import { parseSkillMd } from "../src/skills/store.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

function isCommandSpec(value: unknown): value is CommandSpec {
  return (
    typeof value === "object" && value !== null && "flags" in value && Array.isArray(value.flags)
  );
}

/** União de toda flag declarada em qualquer `*_SPEC` exportado por
 * `arg-spec.ts` — a fonte da verdade que a skill exportada não pode
 * extrapolar (issue #590 AC1). */
function allKnownFlags(): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const value of Object.values(argSpec)) {
    if (!isCommandSpec(value)) continue;
    for (const flag of value.flags) flags.add(flag.name);
  }
  return flags;
}

/** Cada span em crase que parece uma flag (`--algo`, `--algo-composto`),
 * em qualquer lugar do texto — corpo e bloco de código incluídos. */
function citedFlags(text: string): string[] {
  const matches = text.matchAll(/`(--[a-z][a-z0-9-]*)`/gu);
  return [...new Set([...matches].map((m) => m[1] as string))];
}

describe("skills-builtin-contract: gatilho, anti-gatilho e flags reais", () => {
  it("use-lohra-ts existe, cita lohra-ts, e nenhuma flag citada é inventada", () => {
    const content = read("assets/skills/use-lohra-ts/SKILL.md");
    const skill = parseSkillMd(content);
    expect(skill.name).toBe("use-lohra-ts");
    expect(content).toContain("lohra-ts");

    const known = allKnownFlags();
    const cited = citedFlags(content);
    expect(cited.length, "a skill deveria citar ao menos uma flag real").toBeGreaterThan(0);
    const invented = cited.filter((flag) => !known.has(flag));
    expect(invented, "flag citada que não existe em nenhum *_SPEC de arg-spec.ts").toEqual([]);
  });

  it("descriptions de use-lohra-ts e workflow-authoring têm gatilho e anti-gatilho", () => {
    const useLohraTs = parseSkillMd(read("assets/skills/use-lohra-ts/SKILL.md"));
    const workflowAuthoring = parseSkillMd(read("assets/skills/workflow-authoring/SKILL.md"));

    for (const skill of [useLohraTs, workflowAuthoring]) {
      expect(skill.description.length, `${skill.name} sem description`).toBeGreaterThan(0);
      expect(skill.description, `${skill.name} sem anti-gatilho ("Do NOT")`).toMatch(/Do NOT/u);
    }
  });

  it("use-lohra (Python) fica marcada como legado, não apagada", () => {
    const content = read("assets/skills/use-lohra/SKILL.md");
    const skill = parseSkillMd(content);
    expect(skill.name).toBe("use-lohra");
    expect(skill.description).toMatch(/LEGACY/u);
    expect(skill.description).toMatch(/Do NOT/u);
    expect(content).toContain("use-lohra-ts");
  });
});
