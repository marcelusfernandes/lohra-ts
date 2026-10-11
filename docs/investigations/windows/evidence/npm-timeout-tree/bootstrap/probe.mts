import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath, rootPath, compilerPath] = process.argv.slice(2);
if (modulePath === undefined || rootPath === undefined || compilerPath === undefined) {
  throw new Error("usage: probe.mts <prepare.ts> <new-root-parent> <csc.exe>");
}
const { prepareWindowsHelper, verifyWindowsHelper } = await import(
  pathToFileURL(resolve(modulePath)).href
);
mkdirSync(rootPath, { recursive: true });
const runRoot = mkdtempSync(join(rootPath, "prepare-"));
const source = join(runRoot, "hello & literal.cs");
writeFileSync(
  source,
  'using System; class Hello { static int Main() { Console.Write("LOHRA_898_OK"); return 7; } }',
);
let command = "";
let argv: readonly string[] = [];
let compileMs = -1;
const prepared = prepareWindowsHelper({
  sources: [source],
  outputDir: join(runRoot, "output & literal"),
  compilerPath,
  runCompiler: (executable: string, args: readonly string[], options: object) => {
    command = executable;
    argv = [...args];
    const start = performance.now();
    const result = spawnSync(executable, [...args], options);
    compileMs = performance.now() - start;
    return result;
  },
});
const verified = verifyWindowsHelper(prepared);
const start = performance.now();
const launched = spawnSync(verified, [], {
  cwd: runRoot,
  shell: false,
  encoding: "utf8",
  timeout: 3000,
  maxBuffer: 4096,
});
const launchMs = performance.now() - start;
const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8")) as {
  sources: { sha256: string }[];
  compiler: { sha256: string };
  executable: { sha256: string };
};
const output = {
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  compiler: command,
  compilerArgs: argv.map((arg) => arg.replaceAll(runRoot, "<RUN_ROOT>")),
  sourceSha256: manifest.sources[0]?.sha256,
  compilerSha256: manifest.compiler.sha256,
  executableSha256: manifest.executable.sha256,
  manifestSha256: prepared.manifestSha256,
  compileMs,
  launchMs,
  launch: {
    status: launched.status,
    signal: launched.signal,
    errorCode: (launched.error as NodeJS.ErrnoException | undefined)?.code ?? null,
    stdout: launched.stdout,
    stderr: launched.stderr,
  },
  exact: launched.status === 7 && launched.stdout === "LOHRA_898_OK" && launched.stderr === "",
};
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
if (!output.exact) process.exitCode = 1;
