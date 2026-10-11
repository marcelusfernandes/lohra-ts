import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseNativeArgs, runNativePositive } from "../scripts/ci/controle-negativo/native.js";
import { resolveNpmCli } from "../scripts/subprocess/npm.js";

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

const compiler =
  process.platform === "win32"
    ? "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    : "/usr/bin/true";

function argv(repo: ReturnType<typeof fixture>): string[] {
  return [
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
    compiler,
  ];
}

describe("controle nativo positivo explícito", () => {
  it("valida flag, lista explícita de fontes e não aceita SHA vermelho", () => {
    expect(() => parseNativeArgs(["--native-positive"])).toThrow(/NATIVE_ARGUMENTS/);
    expect(() =>
      parseNativeArgs([
        "--native-positive",
        "--base",
        "a",
        "--head",
        "b",
        "--slug",
        "x",
        "--compiler",
        compiler,
        "--source",
        "native/../value.cs",
      ]),
    ).toThrow(/NATIVE_ARGUMENTS/);
    const repo = fixture();
    expect(() => runNativePositive([...argv(repo), "--red", repo.base])).toThrow(
      /NATIVE_POSITIVE_ARGUMENTS/,
    );
  });

  it.runIf(process.platform === "win32")(
    "compila C# estável e executa prova real só no HEAD",
    () => {
      const repo = fixture();
      expect(runNativePositive(argv(repo))).toBe(0);
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "roteia a flag pelo CLI real e rotula somente POSITIVE-ONLY",
    () => {
      const repo = fixture();
      expect(git(repo.root, "diff", repo.base, repo.head, "--", "native/value.cs")).toBe("");
      const result = spawnSync(
        process.execPath,
        [resolveNpmCli({ env: process.env }), "run", "ci:controle-negativo", "--", ...argv(repo)],
        { encoding: "utf8", timeout: 90_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("POSITIVE-ONLY");
      expect(result.stdout).toContain(repo.head);
      expect(result.stdout).not.toContain("assertion-red");
    },
    100_000,
  );

  it.runIf(process.platform === "win32")(
    "recusa compilador ou fonte C# ausente e código C# inválido antes da prova",
    () => {
      const repo = fixture();
      const missingCompiler = argv(repo);
      missingCompiler[missingCompiler.indexOf("--compiler") + 1] = join(repo.root, "missing.exe");
      expect(() => runNativePositive(missingCompiler)).toThrow(/PREPARE_COMPILER_MISSING/);
      const missingSource = argv(repo);
      missingSource[missingSource.indexOf("--source") + 1] = "native/missing.cs";
      expect(() => runNativePositive(missingSource)).toThrow(/NATIVE_GIT/);
      writeFileSync(join(repo.root, "native", "value.cs"), "invalid C#");
      git(repo.root, "add", "native/value.cs");
      git(repo.root, "commit", "-qm", "test: fonte inválida");
      expect(() =>
        runNativePositive(argv({ ...repo, head: git(repo.root, "rev-parse", "HEAD") })),
      ).toThrow(/PREPARE_COMPILE_FAILED/);
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "recusa prova sem casos executados",
    () => {
      const repo = fixture();
      writeFileSync(
        join(repo.root, "tests", "native-value.test.ts"),
        'import { it } from "vitest"; it.skip("não executado", () => {});\n',
      );
      git(repo.root, "add", "tests/native-value.test.ts");
      git(repo.root, "commit", "-qm", "test: caso vazio");
      expect(() =>
        runNativePositive(argv({ ...repo, head: git(repo.root, "rev-parse", "HEAD") })),
      ).toThrow(/NATIVE_PROOF_RESULT/);
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "recusa script de mesmo sufixo antes de executar ou admitir relatório falso",
    () => {
      const repo = fixture();
      const fakeRoot = mkdtempSync(join(tmpdir(), "native-positive-fake-"));
      ownDirs.push(fakeRoot);
      const fakeDir = join(fakeRoot, "scripts", "prova");
      mkdirSync(fakeDir, { recursive: true });
      const marker = join(fakeRoot, "executado.txt");
      writeFileSync(
        join(fakeDir, "run.ts"),
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "falso");`,
      );
      writeFileSync(
        join(repo.root, "package.json"),
        JSON.stringify({ private: true, scripts: { prova: `tsx "${join(fakeDir, "run.ts")}"` } }),
      );
      git(repo.root, "add", "package.json");
      git(repo.root, "commit", "-qm", "test: harness falso com mesmo sufixo");
      expect(() =>
        runNativePositive(argv({ ...repo, head: git(repo.root, "rev-parse", "HEAD") })),
      ).toThrow(/NATIVE_HARNESS_INVALID/);
      expect(existsSync(marker)).toBe(false);
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "recusa relatório ausente ou inválido e erro/sinal/prazo do processo",
    () => {
      const repo = fixture();
      expect(() =>
        runNativePositive(argv(repo), { runProof: () => ({ status: 0, signal: null }) }),
      ).toThrow(/NATIVE_REPORT_MISSING_OR_LARGE/);
      expect(() =>
        runNativePositive(argv(repo), {
          runProof: (root, slug) => {
            const out = join(root, ".prova", slug);
            mkdirSync(out, { recursive: true });
            writeFileSync(join(out, "vitest.json"), "{invalid JSON");
            writeFileSync(join(out, "resumo.json"), '{"ok":true,"total":1,"falhas":[]}');
            return { status: 0, signal: null };
          },
        }),
      ).toThrow(/NATIVE_REPORT_INVALID/);
      expect(() =>
        runNativePositive(argv(repo), {
          runProof: () => ({ status: null, signal: "SIGTERM" }),
        }),
      ).toThrow(/NATIVE_PROOF_PROCESS.*SIGTERM/);
      expect(() =>
        runNativePositive(argv(repo), {
          runProof: () => ({
            status: null,
            signal: null,
            error: Object.assign(new Error("proof timeout"), { code: "ETIMEDOUT" }),
          }),
        }),
      ).toThrow(/NATIVE_PROOF_PROCESS.*timeout/);
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "preserva causa primária quando cleanup falha após remover o worktree próprio",
    () => {
      const repo = fixture();
      try {
        runNativePositive(argv(repo), {
          runProof: () => ({ status: null, signal: "SIGTERM" }),
          removeWorktree: (root, path) => {
            git(root, "worktree", "remove", "--force", path);
            return { status: 1, stdout: "", stderr: "cleanup marker", signal: null };
          },
        });
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        expect(String(error)).toContain("NATIVE_PROOF_PROCESS");
        expect(
          (error as AggregateError).errors.some((item: unknown) =>
            String(item).includes("cleanup marker"),
          ),
        ).toBe(true);
      }
    },
    30_000,
  );

  it.runIf(process.platform !== "win32")("não simula compilação Win32 em Linux", () => {
    const repo = fixture();
    expect(() => runNativePositive(argv(repo))).toThrow(/NATIVE_PLATFORM_WINDOWS_REQUIRED/);
  });
});
