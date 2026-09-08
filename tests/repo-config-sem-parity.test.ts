// Issue #216: depois da remoção do harness de paridade (#167), a config do
// topo do repo e a skill `worktree-segura` não citam mais `.parity-evidence`,
// `.oracle-venv` nem o diretório do harness (montado por partes abaixo). `lohra/` (checkout opcional do Python,
// só no disco do owner) e `.mutation-evidence/` continuam ignorados.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string): string => readFileSync(new URL(rel, `file://${ROOT}`), "utf8");

const ARQUIVOS = [
  ".gitignore",
  ".prettierignore",
  "eslint.config.js",
  ".claude/skills/worktree-segura/SKILL.md",
] as const;

// O caminho do harness é montado por partes: tests/tests-sem-parity.test.ts
// (#166) reprova qualquer literal dele em tests/, e esta é uma asserção de
// ausência, não um acoplamento.
const HARNESS = ["scripts", "parity"].join("/");
const PROIBIDOS = [".parity-evidence", ".probe-evidence", ".oracle-venv", HARNESS] as const;

describe("config do repo sem o harness de paridade (#216)", () => {
  for (const arquivo of ARQUIVOS) {
    it(`${arquivo} não cita ${PROIBIDOS.join(", ")}`, () => {
      const texto = read(arquivo);
      for (const proibido of PROIBIDOS) {
        expect(texto, `${arquivo} ainda cita ${proibido}`).not.toContain(proibido);
      }
    });
  }

  it(".gitignore mantém lohra/ e .mutation-evidence/", () => {
    const linhas = read(".gitignore").split("\n");
    expect(linhas).toContain("lohra/");
    expect(linhas).toContain(".mutation-evidence/");
  });
});
