import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  declaredUnitsText,
  parseNativeArgs,
  runNative,
  selectNativeRed,
} from "../scripts/ci/controle-negativo/native.js";

const ownDirs: string[] = [];
afterEach(() => {
  for (const dir of ownDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`fixture git ${String(args[0])}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(
  options: {
    redSource?: string;
    testBody?: string;
    headOnlyModule?: boolean;
    headDriver?: boolean;
  } = {},
): {
  root: string;
  base: string;
  red: string;
  head: string;
} {
  const root = mkdtempSync(join(tmpdir(), "native-gate-fixture-"));
  ownDirs.push(root);
  const repo = resolve(".");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { prova: `tsx "${join(repo, "scripts", "prova", "run.ts")}"` },
    }),
  );
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "junction");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.prova/\n");
  git(root, "add", "package.json", ".gitignore");
  git(root, "commit", "-qm", "chore: fixture");
  const base = git(root, "rev-parse", "HEAD");
  mkdirSync(join(root, "native"));
  mkdirSync(join(root, "tests"));
  mkdirSync(join(root, "prova"));
  writeFileSync(
    join(root, "native", "value.cs"),
    options.redSource ??
      'using System; class Program { static void Main() { Console.Write("RED"); } }',
  );
  writeFileSync(
    join(root, "tests", "native-value.test.ts"),
    options.testBody ??
      `
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
${options.headOnlyModule ? 'import { marker } from "../src/head-only.js";' : ""}
it("observa o valor compilado", () => {
  ${options.headOnlyModule ? 'expect(marker).toBe("HEAD");' : ""}
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
  git(root, "add", "native", "tests", "prova");
  git(root, "commit", "-qm", "test(red): medir saída C#");
  const red = git(root, "rev-parse", "HEAD");
  if (options.headOnlyModule) {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "head-only.ts"), 'export const marker = "HEAD";\n');
    git(root, "add", "src/head-only.ts");
  }
  if (options.headDriver) {
    writeFileSync(
      join(root, "tests", "driver.cs"),
      'public static class Driver { public const string Value = "GREEN"; }\n',
    );
    git(root, "add", "tests/driver.cs");
  }
  writeFileSync(
    join(root, "native", "value.cs"),
    options.headDriver
      ? "using System; class Program { static void Main() { Console.Write(Driver.Value); } }"
      : 'using System; class Program { static void Main() { Console.Write("GREEN"); } }',
  );
  git(root, "add", "native/value.cs");
  git(root, "commit", "-qm", "fix: devolver valor esperado");
  const head = git(root, "rev-parse", "HEAD");
  return { root, base, red, head };
}

const compiler =
  process.platform === "win32"
    ? "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    : "/usr/bin/true"; // Só o parser/seleção portáteis; Linux não compila EXE.
function argv(repo: ReturnType<typeof fixture>): string[] {
  return [
    "--native",
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

describe("controle negativo nativo opt-in", () => {
  it("recusa uma invocação sem base, HEAD, prova ou fontes antes de preparar artefatos", () => {
    expect(() => runNative(["--native"])).toThrow(/NATIVE_ARGUMENTS/);
  });

  it("recusa fonte com travessia e flags repetidas", () => {
    expect(() =>
      parseNativeArgs([
        "--native",
        "--base",
        "a",
        "--head",
        "b",
        "--slug",
        "x",
        "--compiler",
        compiler,
        "--source",
        "tests/../driver.cs",
      ]),
    ).toThrow(/NATIVE_ARGUMENTS/);
    expect(() => parseNativeArgs(["--base", "a", "--base", "b"])).toThrow(/NATIVE_ARGUMENTS/);
  });

  it("lê somente a declaração efetiva e recusa expressão dinâmica/computed", () => {
    expect(
      declaredUnitsText(
        '/* unit: ["tests/fake.test.ts"] */ export default { unit: ["tests/real.test.ts"] }',
      ),
    ).toEqual(["tests/real.test.ts"]);
    expect(() => declaredUnitsText("export default { unit: [...other] }")).toThrow(
      /NATIVE_PROOF_DECLARATION/,
    );
    expect(() =>
      declaredUnitsText('export default { unit: ["tests/one.test.ts"], ["unit"]: [] }'),
    ).toThrow(/NATIVE_PROOF_DECLARATION/);
  });

  it("escolhe o commit test(red) causal e recusa SHA fora do intervalo", () => {
    const repo = fixture();
    expect(selectNativeRed(parseNativeArgs(argv(repo)))).toBe(repo.red);
    expect(() => selectNativeRed(parseNativeArgs([...argv(repo), "--red", repo.base]))).toThrow(
      /NATIVE_RED_SELECTION/,
    );
  });

  it("não escolhe entre dois commits test(red) sem SHA explícito", () => {
    const repo = fixture();
    writeFileSync(
      join(repo.root, "native", "value.cs"),
      'using System; class Program { static void Main() { Console.Write("OTHER"); } }',
    );
    writeFileSync(
      join(repo.root, "tests", "native-value.test.ts"),
      readFileSync(join(repo.root, "tests", "native-value.test.ts"), "utf8") + "\n// segundo red\n",
    );
    git(repo.root, "add", "native", "tests");
    git(repo.root, "commit", "-qm", "test(red): segundo candidato");
    const head = git(repo.root, "rev-parse", "HEAD");
    const options = parseNativeArgs(argv({ ...repo, head }));
    expect(() => selectNativeRed(options)).toThrow(/NATIVE_RED_SELECTION/);
    expect(selectNativeRed(parseNativeArgs([...argv({ ...repo, head }), "--red", repo.red]))).toBe(
      repo.red,
    );
  });

  it.runIf(process.platform === "win32")(
    "recusa C# inválido como setup, sem classificá-lo como assertion-red",
    () => {
      const repo = fixture({ redSource: "this is not valid C#" });
      expect(() => runNative(argv(repo))).toThrow(/PREPARE_COMPILE_FAILED/);
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "recusa compilador ausente antes da prova",
    () => {
      const repo = fixture();
      const args = argv(repo);
      args[args.length - 1] = join(repo.root, "missing-csc.exe");
      expect(() => runNative(args)).toThrow(/PREPARE_COMPILER_MISSING/);
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "recusa falso vermelho e vermelho estrutural",
    () => {
      const falseRed = fixture({
        redSource:
          'using System; class Program { static void Main() { Console.Write("GREEN"); } } // red variant',
      });
      expect(() => runNative(argv(falseRed))).toThrow(/NATIVE_PROOF_PROCESS/);
      const structural = fixture({ headOnlyModule: true });
      expect(() => runNative(argv(structural))).toThrow(/NATIVE_PROOF_RESULT/);
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "recusa relatório produzido por outro script",
    () => {
      const repo = fixture();
      writeFileSync(
        join(repo.root, "package.json"),
        JSON.stringify({ private: true, scripts: { prova: "node fake-report.cjs" } }),
      );
      writeFileSync(join(repo.root, "fake-report.cjs"), "process.exit(0);\n");
      git(repo.root, "add", "package.json", "fake-report.cjs");
      git(repo.root, "commit", "-qm", "test: relatório falso");
      expect(() => runNative(argv({ ...repo, head: git(repo.root, "rev-parse", "HEAD") }))).toThrow(
        /NATIVE_HARNESS_INVALID/,
      );
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "aplica driver C# final do overlay, mantendo fonte de produto de cada SHA",
    () => {
      const repo = fixture({ headDriver: true });
      expect(runNative([...argv(repo), "--source", "tests/driver.cs"])).toBe(0);
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "recusa zero teste executado apesar da unidade declarada",
    () => {
      const repo = fixture({
        testBody: 'import { it } from "vitest"; it.skip("não executado", () => {});',
      });
      expect(() => runNative(argv(repo))).toThrow(/NATIVE_PROOF_RESULT/);
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "recusa prazo/erro de processo e relatório ausente",
    () => {
      const repo = fixture();
      expect(() =>
        runNative(argv(repo), {
          runProof: () => ({
            status: null,
            signal: null,
            error: Object.assign(new Error("proof timeout"), { code: "ETIMEDOUT" }),
          }),
        }),
      ).toThrow(/NATIVE_PROOF_PROCESS.*timeout/);
      expect(() =>
        runNative(argv(repo), { runProof: () => ({ status: 1, signal: null }) }),
      ).toThrow(/NATIVE_REPORT_MISSING_OR_LARGE/);
      expect(() =>
        runNative(argv(repo), {
          runProof: (root, slug) => {
            const out = join(root, ".prova", slug);
            mkdirSync(out, { recursive: true });
            writeFileSync(join(out, "vitest.json"), "{invalid JSON");
            writeFileSync(join(out, "resumo.json"), '{"ok":false,"total":1,"falhas":[]}');
            return { status: 1, signal: null };
          },
        }),
      ).toThrow(/NATIVE_REPORT_INVALID/);
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "preserva falha primária e de cleanup sem worktree registrado",
    () => {
      const repo = fixture({ redSource: "invalid C#" });
      let removals = 0;
      try {
        runNative(argv(repo), {
          removeWorktree: (root, path) => {
            const result = spawnSync("git", ["worktree", "remove", "--force", path], {
              cwd: root,
              encoding: "utf8",
            });
            expect(result.status).toBe(0);
            removals++;
            return { status: 1, stdout: "", stderr: "cleanup marker", signal: null };
          },
        });
        throw new Error("expected native failure");
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        expect(String(error)).toContain("PREPARE_COMPILE_FAILED");
        expect(
          (error as AggregateError).errors.some((item: unknown) =>
            String(item).includes("cleanup marker"),
          ),
        ).toBe(true);
      }
      expect(removals).toBe(2);
      expect(git(repo.root, "worktree", "list", "--porcelain")).not.toContain(
        "lohra-native-negative-",
      );
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "recusa declaração sem testes mesmo após compilar os dois artefatos",
    () => {
      const repo = fixture();
      writeFileSync(join(repo.root, "prova", "native-value.ts"), "export default { unit: [] };\n");
      git(repo.root, "add", "prova/native-value.ts");
      git(repo.root, "commit", "-qm", "test: declaração vazia");
      expect(() => runNative(argv({ ...repo, head: git(repo.root, "rev-parse", "HEAD") }))).toThrow(
        /NATIVE_PROOF_DECLARATION/,
      );
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "pré-compila os dois SHAs e observa assertion-red/verde no mesmo teste real",
    () => {
      const repo = fixture();
      expect(runNative(argv(repo))).toBe(0);
      expect(readFileSync(join(repo.root, "native", "value.cs"), "utf8")).toContain("GREEN");
    },
    90_000,
  );

  it.runIf(process.platform !== "win32")("não simula execução Win32 em Linux", () => {
    const repo = fixture();
    expect(() => runNative(argv(repo))).toThrow(/NATIVE_PLATFORM_WINDOWS_REQUIRED/);
  });
});
