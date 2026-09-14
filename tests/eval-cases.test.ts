// Issue #576: a disciplina do split (`tests/fixtures/eval/split.json`) e o
// oráculo de mecanismo rodando de verdade contra o stub — o "roda em `npm
// test` como suíte normal" da issue. Nunca ajusta holdout para fazer um
// caso passar; holdout só é lido aqui, nunca usado para calibrar texto.
//
// Rodada 1b: o CLI é invocado in-process (`runCli`, `scripts/eval/session.ts`)
// — nunca `dist/cli.js` — porque `npm test` roda ANTES de `npm run build`
// no CI (`tests/ci-workflow-order.test.ts`); um teste que exigisse `dist/`
// reprovaria a coleta inteira nesse job.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { detectDangerousCommand } from "../src/tools/approval.js";
import { loadCase, loadSplit, FIXTURES_DIR } from "../scripts/eval/run.js";
import { runEvalCase } from "../scripts/eval/session.js";
import { runCaseToResultLine } from "../scripts/eval/runner.js";
import type { MechanismResult } from "../scripts/eval/types.js";

const root = resolve(import.meta.dirname, "..");

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

// Issue #607 item 5: `runEvalCase` (via `runInProcess`, `scripts/eval/session.ts`)
// faz `process.chdir` — estado GLOBAL do processo do runner de teste, não
// por-teste. `it.each` roda estes casos em SÉRIE de propósito (o padrão
// default do vitest dentro de um `describe`); nunca troque por
// `it.concurrent`/`describe.concurrent` aqui sem antes isolar o cwd por
// caso (ex.: `cwd_fixture` some, um `read_file`/`write_file`/`terminal`
// relativo de um caso concorrente resolveria contra o cwd de OUTRO caso
// ainda em voo).
describe("mechanism oracle against the stub", () => {
  it.each(allIds)(
    "case %s: every mechanism assertion passes against the stub",
    async (id) => {
      const kase = loadCase(root, id);
      const line = await runCaseToResultLine(kase, { timeoutMs: 20_000 }, runEvalCase);
      expect(line.mechanismOk, describeFailures(line.mechanism)).toBe(true);
      expect(line.timedOut).toBe(false);
    },
    20_000,
  );
});

interface RawStubCall {
  readonly name?: unknown;
  readonly argumentsRaw?: unknown;
}

function terminalCommandsIn(raw: unknown): readonly string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const stubScript = (raw as { stub_script?: unknown }).stub_script;
  if (typeof stubScript !== "object" || stubScript === null) return [];
  const commands: string[] = [];
  for (const steps of Object.values(stubScript as Record<string, unknown>)) {
    if (!Array.isArray(steps)) continue;
    for (const step of steps as readonly unknown[]) {
      const calls = (step as { calls?: unknown }).calls;
      if (!Array.isArray(calls)) continue;
      for (const call of calls as readonly RawStubCall[]) {
        if (call.name !== "terminal" || typeof call.argumentsRaw !== "string") continue;
        const parsed = JSON.parse(call.argumentsRaw) as { command?: unknown };
        if (typeof parsed.command === "string") commands.push(parsed.command);
      }
    }
  }
  return commands;
}

// Comandos que a política de comando perigoso (`src/tools/approval.ts`)
// NUNCA recusaria — ou seja, que executariam de verdade, com o ambiente
// REAL do processo (`src/tools/terminal.ts:121` spawna com `env:
// process.env`, não com a allowlist do stub — issue #607 item 1). Um
// comando que a política recusa nunca chega a spawnar (`terminal.ts:82-99`
// devolve o erro antes disso), então nunca toca env nenhum — não precisa
// estar neste allowlist.
const SAFE_TERMINAL_COMMAND = /^(echo|printf)\b/;

describe("terminal isolation pin (issue #607 item 1)", () => {
  // `terminal` in-process herda o ambiente real do operador que roda
  // `npm test`/`npm run eval` — nunca a allowlist isolada que o resto do
  // harness usa contra o stub (`session.ts:15-19` documenta esse limite).
  // Isso é inócuo hoje porque nenhum comando que de fato EXECUTA (não
  // recusado pela política) faz rede — este teste é o pino: um fixture
  // novo com `terminal curl ...`/`wget ...`/etc. reprova aqui antes de
  // fazer rede de verdade em `npm test`.
  it("no fixture spawns a real, network-capable terminal command", () => {
    for (const id of fixtureIds()) {
      const path = resolve(root, FIXTURES_DIR, `${id}.json`);
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      for (const command of terminalCommandsIn(raw)) {
        if (detectDangerousCommand(command) !== null) continue;
        expect(
          command,
          `${id}: comando de terminal "${command}" executaria de verdade com o ambiente ` +
            "real do operador (não está no allowlist seguro deste pino)",
        ).toMatch(SAFE_TERMINAL_COMMAND);
      }
    }
  });
});
