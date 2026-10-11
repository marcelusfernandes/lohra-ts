import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const EXE = "helper.exe";
const MANIFEST = "manifest.json";
const SOURCE_MAX = 1024 * 1024;
const MANIFEST_MAX = 64 * 1024;

interface CompileResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly error?: Error;
}
interface CompileOptions {
  readonly cwd: string;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly windowsHide: true;
}
type Compiler = (
  command: string,
  argv: readonly string[],
  options: CompileOptions,
) => CompileResult;
interface HashedPath {
  readonly path: string;
  readonly sha256: string;
}
interface ManifestData {
  readonly schema: 1;
  readonly sources: readonly HashedPath[];
  readonly compiler: HashedPath;
  readonly options: {
    readonly target: "exe";
    readonly timeoutMs: number;
    readonly maxBuffer: number;
  };
  readonly executable: { readonly name: typeof EXE; readonly sha256: string };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hashedPath(value: unknown): value is HashedPath {
  return record(value) && typeof value.path === "string" && typeof value.sha256 === "string";
}
function manifestData(value: unknown): value is ManifestData {
  if (
    !record(value) ||
    value.schema !== 1 ||
    !Array.isArray(value.sources) ||
    value.sources.length < 1 ||
    value.sources.length > 16 ||
    !(value.sources as unknown[]).every(hashedPath) ||
    !hashedPath(value.compiler) ||
    !record(value.executable) ||
    value.executable.name !== EXE ||
    typeof value.executable.sha256 !== "string" ||
    !record(value.options) ||
    value.options.target !== "exe" ||
    typeof value.options.timeoutMs !== "number" ||
    typeof value.options.maxBuffer !== "number"
  ) {
    return false;
  }
  return true;
}
export interface PreparedWindowsHelper {
  readonly outputDir: string;
  readonly executablePath: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
}
export interface PrepareWindowsHelperOptions {
  readonly sources: readonly string[];
  readonly outputDir: string;
  readonly compilerPath: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly runCompiler?: Compiler;
}
export class WindowsHelperPrepareError extends Error {
  constructor(
    readonly code: string,
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = "WindowsHelperPrepareError";
  }
}
function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function absolute(path: string, code: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new WindowsHelperPrepareError(code);
  const resolved = resolve(path);
  let parent = dirname(resolved);
  try {
    while (parent !== dirname(parent)) {
      if (lstatSync(parent).isSymbolicLink()) throw new Error("reparse ancestor");
      parent = dirname(parent);
    }
  } catch (cause) {
    throw new WindowsHelperPrepareError(code, cause);
  }
  return resolved;
}
function bounded(value: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new WindowsHelperPrepareError(code);
  }
  return value;
}
function regular(path: string, code: string, maximum = SOURCE_MAX): Buffer {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
      throw new Error("not a bounded regular file");
    }
    return readFileSync(path);
  } catch (cause) {
    throw new WindowsHelperPrepareError(code, cause);
  }
}
function sourcesOf(paths: readonly string[]): HashedPath[] {
  if (paths.length < 1 || paths.length > 16)
    throw new WindowsHelperPrepareError("PREPARE_SOURCE_INVALID");
  const ordered = paths.map((p) => absolute(p, "PREPARE_SOURCE_INVALID")).sort();
  if (new Set(ordered).size !== ordered.length)
    throw new WindowsHelperPrepareError("PREPARE_SOURCE_INVALID");
  return ordered.map((path) => ({ path, sha256: digest(regular(path, "PREPARE_SOURCE_INVALID")) }));
}
function cleanOwnOutput(dir: string): void {
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WindowsHelperPrepareError("PREPARE_CLEANUP_REPARSE");
  }
  for (const name of [MANIFEST, EXE]) {
    const file = join(dir, name);
    try {
      lstatSync(file);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    unlinkSync(file);
  }
  rmdirSync(dir);
}
function assertCompile(result: CompileResult): void {
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new WindowsHelperPrepareError(
      code === "ETIMEDOUT"
        ? "PREPARE_COMPILE_TIMEOUT"
        : code === "ENOBUFS"
          ? "PREPARE_COMPILE_OUTPUT_LIMIT"
          : "PREPARE_COMPILE_LAUNCH",
      result.error,
    );
  }
  if (result.status !== 0) {
    throw new WindowsHelperPrepareError(
      "PREPARE_COMPILE_FAILED",
      new Error(`compiler status ${String(result.status)} signal ${String(result.signal)}`),
    );
  }
}
export function prepareWindowsHelper(options: PrepareWindowsHelperOptions): PreparedWindowsHelper {
  const outputDir = absolute(options.outputDir, "PREPARE_DESTINATION_INVALID");
  const compilerPath = absolute(options.compilerPath, "PREPARE_COMPILER_MISSING");
  const sources = sourcesOf(options.sources);
  const compiler = {
    path: compilerPath,
    sha256: digest(regular(compilerPath, "PREPARE_COMPILER_MISSING", 32 * SOURCE_MAX)),
  };
  const timeoutMs = bounded(options.timeoutMs ?? 10_000, 60_000, "PREPARE_TIMEOUT_INVALID");
  const maxBuffer = bounded(
    options.maxBuffer ?? SOURCE_MAX,
    16 * SOURCE_MAX,
    "PREPARE_MAX_BUFFER_INVALID",
  );
  const executablePath = join(outputDir, EXE);
  const manifestPath = join(outputDir, MANIFEST);
  try {
    mkdirSync(outputDir);
  } catch (cause) {
    throw new WindowsHelperPrepareError(
      (cause as NodeJS.ErrnoException).code === "EEXIST"
        ? "PREPARE_DESTINATION_EXISTS"
        : "PREPARE_DESTINATION_CREATE",
      cause,
    );
  }
  try {
    const args = [
      "/nologo",
      "/target:exe",
      `/out:${executablePath}`,
      ...sources.map((s) => s.path),
    ];
    const runCompiler: Compiler = options.runCompiler ?? spawnSync;
    let result: CompileResult;
    try {
      result = runCompiler(compilerPath, args, {
        cwd: outputDir,
        timeout: timeoutMs,
        maxBuffer,
        shell: false,
        windowsHide: true,
      });
    } catch (cause) {
      throw new WindowsHelperPrepareError("PREPARE_COMPILE_LAUNCH", cause);
    }
    assertCompile(result);
    for (const source of sources) {
      if (digest(regular(source.path, "PREPARE_SOURCE_INVALID")) !== source.sha256) {
        throw new WindowsHelperPrepareError("PREPARE_SOURCE_STALE");
      }
    }
    if (
      digest(regular(compilerPath, "PREPARE_COMPILER_MISSING", 32 * SOURCE_MAX)) !== compiler.sha256
    ) {
      throw new WindowsHelperPrepareError("PREPARE_COMPILER_STALE");
    }
    const executable = regular(executablePath, "PREPARE_EXECUTABLE_MISSING", 32 * SOURCE_MAX);
    const manifest: ManifestData = {
      schema: 1,
      sources,
      compiler,
      options: { target: "exe", timeoutMs, maxBuffer },
      executable: { name: EXE, sha256: digest(executable) },
    };
    const serialized = JSON.stringify(manifest);
    if (Buffer.byteLength(serialized) > MANIFEST_MAX) {
      throw new WindowsHelperPrepareError("PREPARE_MANIFEST_TOO_LARGE");
    }
    writeFileSync(manifestPath, serialized, { flag: "wx" });
    return { outputDir, executablePath, manifestPath, manifestSha256: digest(serialized) };
  } catch (cause) {
    try {
      cleanOwnOutput(outputDir);
    } catch (cleanupCause) {
      throw new WindowsHelperPrepareError(
        "PREPARE_CLEANUP_FAILED",
        new AggregateError([cause, cleanupCause], "preparation and cleanup failed"),
      );
    }
    throw cause;
  }
}
export function verifyWindowsHelper(descriptor: PreparedWindowsHelper): string {
  const dir = absolute(descriptor.outputDir, "HELPER_CORRUPT");
  if (
    descriptor.executablePath !== join(dir, EXE) ||
    descriptor.manifestPath !== join(dir, MANIFEST)
  ) {
    throw new WindowsHelperPrepareError("HELPER_CORRUPT");
  }
  let serialized: Buffer;
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("reparse");
    serialized = regular(descriptor.manifestPath, "HELPER_MISSING", MANIFEST_MAX);
  } catch (cause) {
    throw new WindowsHelperPrepareError("HELPER_MISSING", cause);
  }
  if (digest(serialized) !== descriptor.manifestSha256)
    throw new WindowsHelperPrepareError("HELPER_CORRUPT");
  let manifest: unknown;
  try {
    manifest = JSON.parse(serialized.toString("utf8")) as unknown;
  } catch (cause) {
    throw new WindowsHelperPrepareError("HELPER_CORRUPT", cause);
  }
  if (!manifestData(manifest)) throw new WindowsHelperPrepareError("HELPER_CORRUPT");
  for (const source of manifest.sources) {
    if (digest(regular(source.path, "HELPER_SOURCE_MISSING")) !== source.sha256) {
      throw new WindowsHelperPrepareError("HELPER_STALE");
    }
  }
  if (
    digest(regular(manifest.compiler.path, "HELPER_COMPILER_MISSING", 32 * SOURCE_MAX)) !==
    manifest.compiler.sha256
  ) {
    throw new WindowsHelperPrepareError("HELPER_STALE");
  }
  if (
    digest(regular(descriptor.executablePath, "HELPER_MISSING", 32 * SOURCE_MAX)) !==
    manifest.executable.sha256
  ) {
    throw new WindowsHelperPrepareError("HELPER_CORRUPT");
  }
  return descriptor.executablePath;
}
