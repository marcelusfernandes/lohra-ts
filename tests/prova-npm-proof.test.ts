import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const runScript = resolve(root, "scripts/prova/run.ts");
const tsxLoader = import.meta.resolve("tsx");
const timeoutMs = 60_000;
const workdirs: string[] = [];

afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "lohra-prova-npm-"));
  workdirs.push(dir);
  symlinkSync(resolve(root, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "prova"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "prova-npm-fixture", scripts: { typecheck: "node check.cjs" } }),
  );
  writeFileSync(
    join(dir, "check.cjs"),
    exitCode === 0
      ? 'process.stdout.write("TYPECHECK_OK_742\\n");\n'
      : `process.stderr.write("TYPECHECK_FAILED_742\\n"); process.exit(${String(exitCode)});\n`,
  );
  writeFileSync(
    join(dir, "prova", "npmfixture.ts"),
    'export default { unit: ["tests/ok.test.ts"], check: true };\n',
  );
  writeFileSync(
    join(dir, "tests", "ok.test.ts"),
    'import { expect, it } from "vitest"; it("ok", () => expect(1).toBe(1));\n',
  );
  return dir;
}

function runFixture(dir: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
  );
  return spawnSync(process.execPath, ["--import", tsxLoader, runScript, "npmfixture"], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

it(
  "check:true executes the installed npm typecheck before Vitest on this platform",
  () => {
    const dir = fixture(0);
    const result = runFixture(dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("TYPECHECK_OK_742");
    const resumo: unknown = JSON.parse(
      readFileSync(join(dir, ".prova", "npmfixture", "resumo.json"), "utf8"),
    );
    expect(resumo).toEqual({ ok: true, total: 1, falhas: [] });
  },
  timeoutMs,
);

it(
  "a failing typecheck makes proof fail with its status and diagnostic cause visible",
  () => {
    const dir = fixture(7);
    const result = runFixture(dir);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("TYPECHECK_FAILED_742");
    const resumo = JSON.parse(
      readFileSync(join(dir, ".prova", "npmfixture", "resumo.json"), "utf8"),
    ) as { ok: boolean; total: number; falhas: { nome: string; motivo: string }[] };
    expect(resumo.ok).toBe(false);
    expect(resumo.total).toBe(1);
    expect(resumo.falhas).toHaveLength(1);
    expect(resumo.falhas[0]?.nome).toBe("npm run typecheck");
    expect(resumo.falhas[0]?.motivo).toContain("exit code 7");
    expect(resumo.falhas[0]?.motivo).toContain("TYPECHECK_FAILED_742");
  },
  timeoutMs,
);
