import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { namedMutants } from "../scripts/mutations/workflow-durability-named.js";

const retargetedIds = [
  "i2/spec-widens-policy",
  "s/superseded-stretch-keeps-granting",
  "ab/taint-frozen-before-the-leaves-run",
] as const;

function literalTestNames(file: string): readonly string[] {
  const path = resolve(file);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "it" || node.expression.text === "test")
    ) {
      const title = node.arguments[0];
      if (
        title !== undefined &&
        (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
      ) {
        names.push(title.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return names;
}

describe("workflow durability mutation focus integrity", () => {
  it("runs the three extracted sandbox mutants against two real test cases", () => {
    const selected = namedMutants.filter((mutant) => retargetedIds.some((id) => id === mutant.id));
    expect(selected.map((mutant) => mutant.id).sort()).toEqual([...retargetedIds].sort());
    expect(
      new Set(selected.map((mutant) => `${mutant.focus.file}::${mutant.focus.test}`)).size,
    ).toBe(2);

    for (const mutant of selected) {
      const names = literalTestNames(mutant.focus.file);
      expect(
        names.some((name) => name.includes(mutant.focus.test)),
        mutant.id,
      ).toBe(true);
    }
  });
});
