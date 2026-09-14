// Issue #607 item 6: `npm run eval` sem `--tag` no mesmo dia de um baseline
// commitado (`docs/eval/<data>-<label>/`) sobrescrevia esse baseline
// tracked — só `generatedAt`/`elapsedMs` mudavam, mas o diff era real.
// `resolveOutDir` (`scripts/eval/run.ts`) é a decisão isolada, testável sem
// rodar o harness inteiro.
//
// Issue #653 item 5 (AC4): o caminho `.eval/` nunca tinha sido exercitado
// ponta a ponta — só `resolveOutDir` isolada, acima. `main()` (`run.ts`)
// não é exportada e lê `process.cwd()` diretamente, então não é injetável
// sem reestruturar o CLI; a alternativa que a issue aceita é rodar a MESMA
// sequência que `main()` roda (`loadSplit`/`loadCase` → `resolveOutDir` →
// `runBatch` com o `runEvalCase` real, stub in-process → `buildSummary` →
// `writeSummary`) contra uma raiz temporária com os fixtures copiados —
// prova que o diretório é criado de verdade e que `docs/eval/` da raiz
// temporária fica intocado.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildSummary, writeSummary } from "../scripts/eval/results.js";
import { FIXTURES_DIR, loadCase, loadSplit, resolveOutDir, runBatch } from "../scripts/eval/run.js";
import { runEvalCase } from "../scripts/eval/session.js";
import type { EvalSummary } from "../scripts/eval/types.js";

const realRoot = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const dir of temporaryRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveOutDir", () => {
  it("writes to a gitignored default (never docs/eval/) when --tag is absent", () => {
    const dir = resolveOutDir("/repo", {});
    expect(dir.includes(`${sep}docs${sep}eval${sep}`)).toBe(false);
    expect(dir).toContain(`${sep}.eval${sep}`);
    expect(dir).toMatch(/-stub$/);
  });

  it("writes to a gitignored default for --provider too, still never docs/eval/", () => {
    const dir = resolveOutDir("/repo", { provider: "openrouter" });
    expect(dir.includes(`${sep}docs${sep}eval${sep}`)).toBe(false);
    expect(dir).toMatch(/-openrouter$/);
  });

  it("only writes under docs/eval/ when --tag makes the run an explicit, distinctly-named baseline", () => {
    const dir = resolveOutDir("/repo", { tag: "antes-585" });
    expect(dir).toContain(`${sep}docs${sep}eval${sep}`);
    expect(dir).toMatch(/-stub-antes-585$/);
  });

  it("never collides with a same-day, no-tag baseline directory name once --tag is used", () => {
    const tagged = resolveOutDir("/repo", { tag: "depois-585" });
    const untagged = resolveOutDir("/repo", {});
    expect(tagged).not.toBe(untagged);
  });
});

describe(".eval/ end to end, no --tag (issue #653 item 5)", () => {
  it("a real batch run (stub, in-process) writes .eval/<date>-stub/{results.jsonl,summary.json} and never touches docs/eval/ of the temporary root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-eval-run-output-"));
    temporaryRoots.push(root);
    cpSync(resolve(realRoot, FIXTURES_DIR), resolve(root, FIXTURES_DIR), { recursive: true });

    const split = loadSplit(root);
    const caseId = split.dev[0];
    if (caseId === undefined) throw new Error("split.json não declara nenhum caso dev");
    const cases = [loadCase(root, caseId)];

    const outDir = resolveOutDir(root, {});
    const resultsPath = join(outDir, "results.jsonl");
    const summaryPath = join(outDir, "summary.json");

    const lines = await runBatch(cases, { timeoutMs: 20_000, resultsPath }, runEvalCase);
    const summary = buildSummary("stub", undefined, lines);
    writeSummary(summaryPath, summary);

    expect(existsSync(resultsPath)).toBe(true);
    expect(existsSync(summaryPath)).toBe(true);
    expect(outDir).toContain(`${sep}.eval${sep}`);
    expect(outDir.includes(`${sep}docs${sep}eval${sep}`)).toBe(false);
    expect(existsSync(resolve(root, "docs", "eval"))).toBe(false);

    const onDisk = JSON.parse(readFileSync(summaryPath, "utf8")) as EvalSummary;
    expect(onDisk.total).toBe(1);
    expect(onDisk.cases).toHaveLength(1);
  }, 30_000);
});
