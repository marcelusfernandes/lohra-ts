// Issue #576: a disciplina do split (`tests/fixtures/eval/split.json`) e o
// oráculo de mecanismo rodando de verdade contra o stub — o "roda em `npm
// test` como suíte normal" da issue. Nunca ajusta holdout para fazer um
// caso passar; holdout só é lido aqui, nunca usado para calibrar texto.
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadCase, loadSplit, FIXTURES_DIR } from "../scripts/eval/run.js";
import { runEvalCase } from "../scripts/eval/session.js";
import { runCaseToResultLine } from "../scripts/eval/runner.js";
import type { MechanismResult } from "../scripts/eval/types.js";

const root = resolve(import.meta.dirname, "..");
const cliPath = resolve(root, "dist/cli.js");

beforeAll(() => {
  // Fail-closed (CLAUDE.md, invariante 2): rodar esta suíte num worktree
  // sem build não pode silenciosamente "passar vazio" — tem que dizer por
  // quê. O gate canônico já roda `npm run build` antes de `npm test`
  // (CLAUDE.md, "Gates"); isto só torna o motivo explícito quando alguém
  // roda o arquivo isolado.
  if (!existsSync(cliPath)) {
    throw new Error(`eval: ${cliPath} não existe — rode "npm run build" antes de "npm test"`);
  }
});

function fixtureIds(): readonly string[] {
  return readdirSync(resolve(root, FIXTURES_DIR))
    .filter((name) => name.endsWith(".json") && name !== "split.json")
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

describe("split.json discipline", () => {
  it("declares at least 15 dev cases and 5 holdout cases, disjoint, matching the fixtures on disk", () => {
    const split = loadSplit(root);
    const onDisk = fixtureIds();
    const overlap = split.dev.filter((id) => split.holdout.includes(id));
    expect(overlap, "dev e holdout precisam ser disjuntos").toEqual([]);
    expect(split.dev.length, "pelo menos 15 casos de desenvolvimento").toBeGreaterThanOrEqual(15);
    expect(split.holdout.length, "pelo menos 5 casos de holdout").toBeGreaterThanOrEqual(5);
    expect([...split.dev, ...split.holdout].slice().sort()).toEqual(onDisk);
  });

  it("every declared case parses without throwing", () => {
    const split = loadSplit(root);
    for (const id of [...split.dev, ...split.holdout]) {
      expect(() => loadCase(root, id), `caso "${id}" deveria parsear`).not.toThrow();
    }
  });
});

function describeFailures(results: readonly MechanismResult[]): string {
  return results
    .filter((result) => !result.passed)
    .map((result) => `${result.kind}: ${result.detail}`)
    .join("; ");
}

const split = existsSync(resolve(root, FIXTURES_DIR, "split.json")) ? loadSplit(root) : null;
const allIds = split === null ? [] : [...split.dev, ...split.holdout];

describe("mechanism oracle against the stub", () => {
  it.each(allIds)(
    "case %s: every mechanism assertion passes against the stub",
    async (id) => {
      const kase = loadCase(root, id);
      const line = await runCaseToResultLine(kase, { cliPath, timeoutMs: 20_000 }, runEvalCase);
      expect(line.mechanismOk, describeFailures(line.mechanism)).toBe(true);
      expect(line.timedOut).toBe(false);
    },
    20_000,
  );
});
