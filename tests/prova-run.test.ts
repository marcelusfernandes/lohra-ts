import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const runScript = resolve(root, "scripts/prova/run.ts");
const tsxBin = resolve(root, "node_modules/.bin/tsx");

const workdirs: string[] = [];

afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lohra-prova-run-"));
  workdirs.push(dir);
  symlinkSync(resolve(root, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "prova"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  return dir;
}

function runProva(cwd: string, slug: string): SpawnSyncReturns<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
  );
  return spawnSync(tsxBin, [runScript, slug], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
}

describe("prova run.ts (subprocess)", () => {
  it("runs the declared file and writes a green resumo.json", () => {
    const dir = makeWorkdir();
    writeFileSync(
      join(dir, "prova", "happy.ts"),
      'export default { unit: ["tests/ok.test.ts"] };\n',
    );
    writeFileSync(
      join(dir, "tests", "ok.test.ts"),
      'import { expect, it } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n',
    );

    const result = runProva(dir, "happy");

    expect(result.status, result.stderr).toBe(0);
    const resumoPath = join(dir, ".prova", "happy", "resumo.json");
    expect(existsSync(resumoPath)).toBe(true);
    const resumo: unknown = JSON.parse(readFileSync(resumoPath, "utf8"));
    expect(resumo).toEqual({ ok: true, total: 1, falhas: [] });
  });

  it("exits 1 citing the path when prova/<slug>.ts does not exist", () => {
    const dir = makeWorkdir();
    const result = runProva(dir, "absent");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prova/absent.ts");
  });

  it("exits 1 citing the missing file when a declared unit file does not exist", () => {
    const dir = makeWorkdir();
    writeFileSync(
      join(dir, "prova", "missingfile.ts"),
      'export default { unit: ["tests/does-not-exist.test.ts"] };\n',
    );
    const result = runProva(dir, "missingfile");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tests/does-not-exist.test.ts");
  });

  it("never reports ok:true from a stale report when the second run's vitest crashes before writing one", () => {
    const dir = makeWorkdir();
    writeFileSync(
      join(dir, "prova", "flaky.ts"),
      'export default { unit: ["tests/ok.test.ts"] };\n',
    );
    writeFileSync(
      join(dir, "tests", "ok.test.ts"),
      'import { expect, it } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n',
    );

    const first = runProva(dir, "flaky");
    expect(first.status, first.stderr).toBe(0);
    const resumoPath = join(dir, ".prova", "flaky", "resumo.json");
    expect(existsSync(resumoPath)).toBe(true);
    expect(JSON.parse(readFileSync(resumoPath, "utf8"))).toEqual({
      ok: true,
      total: 1,
      falhas: [],
    });

    // Break vitest's own startup for the SECOND run — a broken vitest.config.ts
    // makes vitest die with a "Startup Error" before it ever opens the
    // outputFile, so nothing overwrites the vitest.json from the first run.
    // The harness must not read that leftover file as if it were fresh.
    writeFileSync(
      join(dir, "vitest.config.ts"),
      'throw new Error("intentionally broken vitest.config.ts — prova stale-report repro");\n',
    );

    const second = runProva(dir, "flaky");

    expect(second.status).not.toBe(0);
    // The stale resumo.json (and the stale vitest.json backing it) must be
    // gone, not silently re-served as this run's result.
    expect(existsSync(resumoPath)).toBe(false);
    // The failure message must name the actual cause (an exit code, or a
    // signal) — not just "no report", which reads the same whether vitest
    // never ran at all or crashed mid-run.
    expect(second.stderr).toMatch(/exit code \d+|sinal/);
  });

  it("check: true folds a failing npm run typecheck into falhas", () => {
    const dir = makeWorkdir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "tmp", version: "0.0.0", scripts: { typecheck: "exit 1" } }),
    );
    writeFileSync(
      join(dir, "prova", "checktrue.ts"),
      'export default { unit: ["tests/ok.test.ts"], check: true };\n',
    );
    writeFileSync(
      join(dir, "tests", "ok.test.ts"),
      'import { expect, it } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n',
    );

    const result = runProva(dir, "checktrue");

    expect(result.status).toBe(1);
    const resumoPath = join(dir, ".prova", "checktrue", "resumo.json");
    const resumo: unknown = JSON.parse(readFileSync(resumoPath, "utf8"));
    expect(resumo).toEqual({
      ok: false,
      total: 1,
      falhas: [{ nome: "npm run typecheck", motivo: "exit code 1" }],
    });
  });

  it("exits 1 when the declared file collects but every test is skip/todo", () => {
    const dir = makeWorkdir();
    writeFileSync(
      join(dir, "prova", "skiponly.ts"),
      'export default { unit: ["tests/allskip.test.ts"] };\n',
    );
    writeFileSync(
      join(dir, "tests", "allskip.test.ts"),
      [
        'import { it } from "vitest";',
        'it.skip("skipped", () => {});',
        'it.todo("not implemented yet");',
        "",
      ].join("\n"),
    );

    const result = runProva(dir, "skiponly");

    expect(result.status).toBe(1);
    const resumoPath = join(dir, ".prova", "skiponly", "resumo.json");
    const resumo = JSON.parse(readFileSync(resumoPath, "utf8")) as {
      ok: boolean;
      total: number;
      falhas: { nome: string; motivo: string }[];
    };
    expect(resumo.ok).toBe(false);
    expect(resumo.total).toBe(0);
    expect(resumo.falhas).toHaveLength(1);
    expect(resumo.falhas[0]?.nome).toBe("tests/allskip.test.ts ran zero tests");
    expect(typeof resumo.falhas[0]?.motivo).toBe("string");
  });

  it("scopes LOHRA_PROVA_OUT by slug instead of sharing one directory across slugs", () => {
    const dir = makeWorkdir();
    writeFileSync(
      join(dir, "prova", "scoped.ts"),
      'export default { unit: ["tests/ok.test.ts"] };\n',
    );
    writeFileSync(
      join(dir, "tests", "ok.test.ts"),
      'import { expect, it } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n',
    );

    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
      ),
      LOHRA_PROVA_OUT: "custom-out",
    };
    const result = spawnSync(tsxBin, [runScript, "scoped"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env,
    });

    expect(result.status, result.stderr).toBe(0);
    const scopedResumoPath = join(dir, "custom-out", "scoped", "resumo.json");
    expect(existsSync(scopedResumoPath)).toBe(true);
    expect(JSON.parse(readFileSync(scopedResumoPath, "utf8"))).toEqual({
      ok: true,
      total: 1,
      falhas: [],
    });
    // The default .prova/<slug>/ path must stay untouched — LOHRA_PROVA_OUT
    // redirects, it doesn't also duplicate into the default location.
    expect(existsSync(join(dir, ".prova", "scoped", "resumo.json"))).toBe(false);
  });
});
