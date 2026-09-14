// Issue #607 item 6: `npm run eval` sem `--tag` no mesmo dia de um baseline
// commitado (`docs/eval/<data>-<label>/`) sobrescrevia esse baseline
// tracked — só `generatedAt`/`elapsedMs` mudavam, mas o diff era real.
// `resolveOutDir` (`scripts/eval/run.ts`) é a decisão isolada, testável sem
// rodar o harness inteiro.
import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveOutDir } from "../scripts/eval/run.js";

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
