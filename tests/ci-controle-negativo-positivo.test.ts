import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runNativePositive } from "../scripts/ci/controle-negativo/native.js";

const ownDirs: string[] = [];
afterEach(() => {
  for (const dir of ownDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`fixture Git: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "native-positive-fixture-"));
  ownDirs.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { prova: `tsx "${resolve("scripts", "prova", "run.ts")}"` },
    }),
  );
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.prova/\n");
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction");
  mkdirSync(join(root, "native"));
  writeFileSync(
    join(root, "native", "value.cs"),
    'using System; class Program { static void Main() { Console.Write("GREEN"); } }',
  );
  git(root, "add", "package.json", ".gitignore", "native/value.cs");
  git(root, "commit", "-qm", "chore: manter fonte C# estável");
  const base = git(root, "rev-parse", "HEAD");
  mkdirSync(join(root, "tests"));
  mkdirSync(join(root, "prova"));
  writeFileSync(
    join(root, "tests", "native-value.test.ts"),
    `import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
it("observa artefato preparado", () => {
  const exe = process.env.LOHRA_NATIVE_HELPER_EXE;
  if (!exe) throw new Error("artefato ausente");
  const result = spawnSync(exe, [], { encoding: "utf8", timeout: 3000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("GREEN");
});
`,
  );
  writeFileSync(
    join(root, "prova", "native-value.ts"),
    'export default { unit: ["tests/native-value.test.ts"] };\n',
  );
  git(root, "add", "tests/native-value.test.ts", "prova/native-value.ts");
  git(root, "commit", "-qm", "test: acrescentar prova positiva");
  return { root, base, head: git(root, "rev-parse", "HEAD") };
}

describe("controle nativo positivo explícito", () => {
  it.runIf(process.platform === "win32")(
    "compila C# estável e executa prova real só no HEAD",
    () => {
      const repo = fixture();
      expect(
        runNativePositive([
          "--native-positive",
          "--root",
          repo.root,
          "--base",
          repo.base,
          "--head",
          repo.head,
          "--slug",
          "native-value",
          "--source",
          "native/value.cs",
          "--compiler",
          "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
        ]),
      ).toBe(0);
    },
    90_000,
  );
});
