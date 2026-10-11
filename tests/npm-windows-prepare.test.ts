import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  prepareWindowsHelper,
  verifyWindowsHelper,
} from "../scripts/subprocess/windows-helper/prepare.js";

const roots: string[] = [];

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "lohra prepare & "));
  roots.push(root);
  const source = join(root, "hello & world.cs");
  const compiler = join(root, "compiler.exe");
  writeFileSync(source, "class Hello { static void Main() {} }");
  writeFileSync(compiler, "compiler fixture");
  return { root, source, compiler, outputDir: join(root, "output & space") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("preparação explícita do helper Windows", () => {
  it("compila uma vez em destino exclusivo, vincula hashes e verifica sem executar", () => {
    const fixture = workspace();
    let calls = 0;
    const prepared = prepareWindowsHelper({
      sources: [fixture.source],
      outputDir: fixture.outputDir,
      compilerPath: fixture.compiler,
      runCompiler: (command, argv, options) => {
        calls++;
        expect(command).toBe(fixture.compiler);
        expect(argv).toContain("/nologo");
        expect(argv).toContain("/target:exe");
        expect(options.shell).toBe(false);
        expect(options.windowsHide).toBe(true);
        const out = argv.find((arg) => arg.startsWith("/out:"));
        if (out === undefined) throw new Error("missing output argument");
        writeFileSync(out.slice(5), "executable fixture");
        return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    expect(calls).toBe(1);
    expect(verifyWindowsHelper(prepared)).toBe(prepared.executablePath);
    expect(calls).toBe(1);
    const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8")) as {
      sources: { sha256: string }[];
      executable: { sha256: string };
      compiler: { sha256: string };
    };
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.sources[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.executable.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.compiler.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("recusa destino existente sem alterar seu conteúdo", () => {
    const fixture = workspace();
    mkdirSync(fixture.outputDir);
    const marker = join(fixture.outputDir, "marker");
    writeFileSync(marker, "keep");
    expect(() =>
      prepareWindowsHelper({
        sources: [fixture.source],
        outputDir: fixture.outputDir,
        compilerPath: fixture.compiler,
      }),
    ).toThrow(/DESTINATION_EXISTS/u);
    expect(readFileSync(marker, "utf8")).toBe("keep");
  });

  it("recusa compiler ausente sem criar destino", () => {
    const fixture = workspace();
    expect(() =>
      prepareWindowsHelper({
        sources: [fixture.source],
        outputDir: fixture.outputDir,
        compilerPath: join(fixture.root, "missing.exe"),
      }),
    ).toThrow(/COMPILER/u);
  });

  it("detecta fonte alterada sem executar o artefato", () => {
    const fixture = workspace();
    const prepared = prepareWindowsHelper({
      sources: [fixture.source],
      outputDir: fixture.outputDir,
      compilerPath: fixture.compiler,
      runCompiler: (_command, argv) => {
        const out = argv.find((arg) => arg.startsWith("/out:"));
        if (out === undefined) throw new Error("missing output argument");
        writeFileSync(out.slice(5), "executable fixture");
        return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    writeFileSync(fixture.source, "changed");
    expect(() => verifyWindowsHelper(prepared)).toThrow(/STALE/u);
  });

  it("ordena fontes sem mutar a lista do chamador", () => {
    const fixture = workspace();
    const second = join(fixture.root, "a source.cs");
    writeFileSync(second, "class Other {}");
    const sources = [fixture.source, second];
    prepareWindowsHelper({
      sources,
      outputDir: fixture.outputDir,
      compilerPath: fixture.compiler,
      runCompiler: (_command, argv) => {
        expect(argv.slice(3)).toEqual([second, fixture.source]);
        const out = argv.find((arg) => arg.startsWith("/out:"));
        if (out === undefined) throw new Error("missing output");
        writeFileSync(out.slice(5), "fixture");
        return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    expect(sources).toEqual([fixture.source, second]);
  });

  it("recusa destino reparse sem tocar no alvo", () => {
    const fixture = workspace();
    const target = join(fixture.root, "target");
    mkdirSync(target);
    const marker = join(target, "marker");
    writeFileSync(marker, "keep");
    symlinkSync(target, fixture.outputDir, process.platform === "win32" ? "junction" : "dir");
    expect(() =>
      prepareWindowsHelper({
        sources: [fixture.source],
        outputDir: fixture.outputDir,
        compilerPath: fixture.compiler,
      }),
    ).toThrow(/DESTINATION_EXISTS/u);
    expect(readFileSync(marker, "utf8")).toBe("keep");
  });

  it("recusa ancestral reparse antes de criar destino", () => {
    const fixture = workspace();
    const target = join(fixture.root, "target-parent");
    const link = join(fixture.root, "linked-parent");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(() =>
      prepareWindowsHelper({
        sources: [fixture.source],
        outputDir: join(link, "new-output"),
        compilerPath: fixture.compiler,
      }),
    ).toThrow(/DESTINATION_INVALID/u);
    expect(existsSync(join(target, "new-output"))).toBe(false);
  });

  it("distingue timeout, excesso de saída e falha de lançamento com causa", () => {
    for (const code of ["ETIMEDOUT", "ENOBUFS", "ENOENT"] as const) {
      const fixture = workspace();
      const error = Object.assign(new Error("compiler failure"), { code });
      let observed: unknown;
      try {
        prepareWindowsHelper({
          sources: [fixture.source],
          outputDir: fixture.outputDir,
          compilerPath: fixture.compiler,
          timeoutMs: 1234,
          maxBuffer: 4096,
          runCompiler: (_command, _argv, options) => {
            expect(options.timeout).toBe(1234);
            expect(options.maxBuffer).toBe(4096);
            return {
              status: null,
              signal: null,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              error,
            };
          },
        });
      } catch (cause) {
        observed = cause;
      }
      expect(observed).toMatchObject({
        code:
          code === "ETIMEDOUT"
            ? "PREPARE_COMPILE_TIMEOUT"
            : code === "ENOBUFS"
              ? "PREPARE_COMPILE_OUTPUT_LIMIT"
              : "PREPARE_COMPILE_LAUNCH",
        cause: error,
      });
      expect(existsSync(fixture.outputDir)).toBe(false);
    }
  });

  it("rejeita compilador que não produziu executável e remove só saída própria", () => {
    const fixture = workspace();
    expect(() =>
      prepareWindowsHelper({
        sources: [fixture.source],
        outputDir: fixture.outputDir,
        compilerPath: fixture.compiler,
        runCompiler: () => ({
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }),
      }),
    ).toThrow(/EXECUTABLE_MISSING/u);
    expect(existsSync(fixture.outputDir)).toBe(false);
    expect(existsSync(fixture.source)).toBe(true);
  });

  it("preserva falha primária quando limpeza encontra arquivo alheio", () => {
    const fixture = workspace();
    let observed: unknown;
    try {
      prepareWindowsHelper({
        sources: [fixture.source],
        outputDir: fixture.outputDir,
        compilerPath: fixture.compiler,
        runCompiler: (_command, _argv, options) => {
          writeFileSync(join(options.cwd, "foreign"), "keep");
          return { status: 7, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      });
    } catch (cause) {
      observed = cause;
    }
    expect(observed).toMatchObject({ code: "PREPARE_CLEANUP_FAILED" });
    expect((observed as Error).cause).toBeInstanceOf(AggregateError);
    expect(readFileSync(join(fixture.outputDir, "foreign"), "utf8")).toBe("keep");
  });

  it("verificador detecta exe adulterado e manifesto ausente", () => {
    const fixture = workspace();
    const prepared = prepareWindowsHelper({
      sources: [fixture.source],
      outputDir: fixture.outputDir,
      compilerPath: fixture.compiler,
      runCompiler: (_command, argv) => {
        const out = argv.find((arg) => arg.startsWith("/out:"));
        if (out === undefined) throw new Error("missing output");
        writeFileSync(out.slice(5), "fixture");
        return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    writeFileSync(prepared.executablePath, "changed");
    expect(() => verifyWindowsHelper(prepared)).toThrow(/CORRUPT/u);
    rmSync(prepared.manifestPath);
    expect(() => verifyWindowsHelper(prepared)).toThrow(/MISSING/u);
  });

  it.runIf(process.platform === "win32")(
    "compila fonte trivial com csc real e executa marcador",
    () => {
      const fixture = workspace();
      const compilerPath = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe";
      writeFileSync(
        fixture.source,
        'using System; class Hello { static int Main() { Console.Write("LOHRA_898_OK"); return 7; } }',
      );
      const prepared = prepareWindowsHelper({
        sources: [fixture.source],
        outputDir: fixture.outputDir,
        compilerPath,
      });
      expect(verifyWindowsHelper(prepared)).toBe(prepared.executablePath);
      const result = spawnSync(prepared.executablePath, [], {
        cwd: fixture.root,
        shell: false,
        encoding: "utf8",
        timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(result.stdout).toBe("LOHRA_898_OK");
      expect(result.stderr).toBe("");
    },
    10_000,
  );
});
