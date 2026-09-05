import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const runScript = resolve(root, "scripts/prova/run.ts");
const tsxBin = resolve(root, "node_modules/.bin/tsx");

function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lohra-prova-run-"));
  symlinkSync(resolve(root, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "prova"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  return dir;
}

function runProva(cwd: string, slug: string): SpawnSyncReturns<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) delete env[key];
  }
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
});
