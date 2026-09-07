import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { COMMAND_SUMMARY, WORKFLOW_SPEC } from "../src/cli/arg-spec.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

interface PackageJsonShape {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const packageJson = JSON.parse(read("package.json")) as PackageJsonShape;

// Issue #164: "não embute nem chama Python" é um fato sobre duas coisas —
// nenhuma dependência do pacote referencia Python, e nenhuma linha de
// `src/` dá spawn/exec num interpretador Python. Não usa o literal
// `"python3"` sozinho: `src/doctor/*` e `src/onboarding/wizard.ts`
// legitimamente relatam a versão do Python do *host* (não chamam nada),
// então a checagem mira a forma de chamada, não a palavra.
const PYTHON_SPAWN_RE =
  /\b(?:spawn|spawnSync|exec|execFile|execSync|execFileSync)\s*\(\s*["'`]python/iu;

function listTsFiles(dir: string): string[] {
  const base = resolve(root, dir);
  return readdirSync(base, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
    .map((entry) => resolve(base, entry));
}

describe("T22 public documentation", () => {
  // Issue #164: nenhum `toContain` deste arquivo pode fixar prosa byte a
  // byte (string com `\n` embutido) — mudar a quebra de linha de uma frase
  // do README não pode reprovar o CI. Meta-teste permanente: lê o próprio
  // arquivo e reprova se essa forma reaparecer.
  it("has no toContain assertion on prose with an embedded newline", () => {
    const source = read("tests/t22-docs.test.ts");
    const embeddedNewlineAssertions = [
      ...source.matchAll(/toContain\(\s*(["'`])(?:(?!\1).)*\\n(?:(?!\1).)*\1/gu),
    ];
    expect(embeddedNewlineAssertions.map((match) => match[0])).toEqual([]);
  });

  it("documents the exact public CLI and current package", () => {
    const readme = read("README.md");
    expect(readme, "MUTATION_CAUSE:T22-docs-current-version").toContain(
      `A versão atual é \`${packageJson.version}\`.`,
    );

    // Fonte da verdade dos comandos públicos é `COMMAND_SUMMARY`
    // (`src/cli/arg-spec.ts`), não a prosa do README — os dois lados
    // derivam do mesmo fato, mas quem muda é `arg-spec.ts`.
    const expectedCommands = Object.keys(COMMAND_SUMMARY);
    const lastCommand = expectedCommands.at(-1);
    expect(lastCommand, "COMMAND_SUMMARY não pode ficar vazio").toBeDefined();
    const commandsBlockRe = new RegExp(
      `Os comandos top-level públicos[\\s\\S]*?\`${String(lastCommand)}\`\\.`,
      "u",
    );
    const documented = commandsBlockRe
      .exec(readme)?.[0]
      .match(/`([a-z-]+)`/gu)
      ?.map((value) => value.slice(1, -1));
    expect(documented).toEqual(expectedCommands);

    // "não existe `workflow run`" é um fato sobre `WORKFLOW_SPEC`, não
    // sobre a quebra de linha da frase do README que o afirma.
    const workflowCmd = WORKFLOW_SPEC.positionals.find((p) => p.name === "workflow_cmd");
    expect(workflowCmd, "WORKFLOW_SPEC perdeu o positional workflow_cmd").toBeDefined();
    expect(workflowCmd?.choices, "workflow_cmd sem choices declarados").toBeDefined();
    expect(workflowCmd?.choices).not.toContain("run");

    const dependencyNames = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    });
    const pythonDependencies = dependencyNames.filter((name) =>
      name.toLowerCase().includes("python"),
    );
    expect(pythonDependencies).toEqual([]);

    const pythonSpawningLines = listTsFiles("src").flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => PYTHON_SPAWN_RE.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(pythonSpawningLines).toEqual([]);

    expect(readme).toContain("NOT_MEASURED");
    expect(readme, "MUTATION_CAUSE:T22-docs-architecture-decided").toContain(
      "O owner escolheu `typescript-mainline`",
    );
  });

  it("records 23 tickets, approved SHAs, debts and owner rulings", () => {
    const closeout = read("docs/closeout.md");
    const tickets = closeout.match(/^\| T(?:0[0-9]|1[0-9]|2[0-2])\s+\|/gmu) ?? [];
    expect(tickets).toHaveLength(23);
    expect(closeout).toContain("D2 / L22");
    expect(closeout).toContain("D3 / M4 e M4-bis");
    expect(closeout).toContain("P2");
    expect(closeout).toContain("NOT_MEASURED");
    expect(closeout).toContain("EVIDENCE_BOUND_FINAL_SHA");
    expect(closeout, "MUTATION_CAUSE:T22-docs-architecture-decided").toContain(
      "typescript-mainline",
    );
    expect(closeout).toContain("gate-decision-t22.md");
    expect(closeout).not.toContain("Gate arquitetural pendente");
  });

  it("has no broken relative Markdown links in public docs", () => {
    for (const path of ["README.md", "docs/closeout.md"]) {
      const text = read(path);
      for (const match of text.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/gu)) {
        const target = match[1];
        if (target === undefined) continue;
        expect(
          existsSync(resolve(root, dirname(path), target)),
          `MUTATION_CAUSE:T22-doc-link:${path}:${target}`,
        ).toBe(true);
      }
    }
  });
});
