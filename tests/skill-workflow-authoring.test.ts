import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const skillPath = resolve(root, "assets/skills/workflow-authoring/SKILL.md");
const skill = readFileSync(skillPath, "utf8");

// Issue #257: a PR #253 (Closes #231) mudou `resolveInlineSchema`
// (`src/workflow/schema.ts`) para aceitar, além de um objeto inline, uma
// string que deve existir em `schemas` — a mesma resolução de `schema_ref`.
// A skill `workflow-authoring` ficou para trás descrevendo `schema` como
// aceitando só um objeto inline. Este teste prende a doutrina nova contra
// deriva futura.
describe("workflow-authoring skill: doutrina de schema", () => {
  it("descreve `schema` como objeto inline OU nome de `schemas`, igual a resolveInlineSchema", () => {
    const sentence = skill.match(/Give a leaf `schema`[\s\S]*?matters downstream\*\*\./u)?.[0];
    expect(sentence, "SKILL.md deve conter a frase sobre `schema`/`schema_ref`").toBeDefined();

    const text = sentence ?? "";

    // Continua descrevendo o objeto inline — não é para sumir, é para
    // ganhar a alternativa.
    expect(text).toMatch(/inline JSON-Schema object/u);

    // A alternativa de nome-string, resolvida contra `schemas` do mesmo
    // jeito que `schema_ref` — o fato que estava faltando.
    expect(text).toMatch(/name string/u);
    expect(text).toMatch(/key in `schemas`/u);
    expect(text).toMatch(/same lookup as `schema_ref`/u);

    // A frase antiga — só objeto inline, sem menção à alternativa — não
    // pode reaparecer depois da correção.
    expect(text).not.toMatch(/schema` \(an inline JSON-Schema object\) or `schema_ref`/u);
  });
});
