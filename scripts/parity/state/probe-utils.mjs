import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export const ORACLE_COMMIT = "16b4785d803ad0ca364a8a67346a04f949fbf592";
export const ORACLE_VERSION = "lohra 0.0.11\n";
export const ORACLE_PYTHON_VERSION = "3.12.10";
export const PROCESS_LIMITS = { timeoutMs: 60_000, maxOutputBytes: 16_777_216 };

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseWorkspace(argv) {
  const index = argv.indexOf("--oracle-workspace");
  const selected = index >= 0 ? argv[index + 1] : process.env.LOHRA_ORACLE_WORKSPACE;
  if (!selected || !isAbsolute(selected)) {
    throw new Error("ORACLE_WORKSPACE: --oracle-workspace must be an absolute path");
  }
  const root = realpathSync(selected);
  const repository = join(root, "lohra");
  const lohra = join(root, ".oracle-venv", "bin", "lohra");
  const python = join(root, ".oracle-venv", "bin", "python");
  for (const path of [repository, lohra, python]) {
    if (!existsSync(path)) throw new Error(`ORACLE_WORKSPACE: missing sanctioned entry ${path}`);
  }
  return { root, repository: realpathSync(repository), lohra, python };
}

export function cleanEnvironment(home, extra = {}) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONUTF8: "1",
    NO_COLOR: "1",
    COLUMNS: "80",
    HOME: home,
    TMPDIR: join(home, "tmp"),
    ...extra,
  };
}

export function runBounded(executable, argv, options) {
  const result = spawnSync(executable, argv, {
    cwd: options.cwd,
    env: options.environment,
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs ?? PROCESS_LIMITS.timeoutMs,
    maxBuffer: options.maxOutputBytes ?? PROCESS_LIMITS.maxOutputBytes,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    const cause = result.error.code === "ETIMEDOUT" ? "PROCESS_TIMEOUT" : "PROCESS_SPAWN";
    throw new Error(`${cause}: ${result.error.message}`);
  }
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function successful(result, cause) {
  if (result.exitCode !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(
      `${cause}: exit=${String(result.exitCode)} signal=${String(result.signal)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  return result.stdout;
}

export function guardBefore(workspace, scratch) {
  const environment = cleanEnvironment(scratch);
  const git = (argv) =>
    successful(
      runBounded("/usr/bin/git", ["-C", workspace.repository, ...argv], {
        cwd: workspace.repository,
        environment,
      }),
      "ORACLE_GIT",
    );
  const commit = git(["rev-parse", "HEAD"]).trim();
  const porcelain = git(["status", "--porcelain"]);
  const version = successful(
    runBounded(workspace.lohra, ["--version"], { cwd: scratch, environment }),
    "ORACLE_VERSION",
  );
  const pythonVersion = successful(
    runBounded(workspace.python, ["-c", "import platform; print(platform.python_version())"], {
      cwd: scratch,
      environment,
    }),
    "ORACLE_PYTHON",
  ).trim();
  if (commit !== ORACLE_COMMIT) throw new Error(`ORACLE_COMMIT_MISMATCH: ${commit}`);
  if (porcelain !== "") throw new Error("ORACLE_DIRTY");
  if (version !== ORACLE_VERSION) throw new Error(`ORACLE_VERSION_MISMATCH: ${version}`);
  if (pythonVersion !== ORACLE_PYTHON_VERSION) {
    throw new Error(`ORACLE_PYTHON_MISMATCH: ${pythonVersion}`);
  }
  return { commit, porcelain, version, pythonVersion };
}

export function guardAfter(workspace, scratch) {
  const environment = cleanEnvironment(scratch);
  const read = (argv) =>
    successful(
      runBounded("/usr/bin/git", ["-C", workspace.repository, ...argv], {
        cwd: workspace.repository,
        environment,
      }),
      "ORACLE_GIT_AFTER",
    );
  const commit = read(["rev-parse", "HEAD"]).trim();
  const porcelain = read(["status", "--porcelain"]);
  if (commit !== ORACLE_COMMIT) throw new Error(`ORACLE_COMMIT_CHANGED: ${commit}`);
  if (porcelain !== "") throw new Error("ORACLE_DIRTY_AFTER");
  return { commit, porcelain };
}

export function parseJsonOutput(result, cause) {
  const stdout = successful(result, cause);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${cause}_PROTOCOL: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

export function writeEvidence(projectRoot, name, raw, projection) {
  const evidenceRoot = resolve(projectRoot, ".probe-evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  const projectionJson = canonicalJson(projection);
  const evidence = {
    schemaVersion: 1,
    probe: name,
    raw,
    projection,
    projectionSha256: sha256(projectionJson),
  };
  const path = join(evidenceRoot, `${name}.json`);
  writeFileSync(path, canonicalJson(evidence), "utf8");
  return { path, sha: evidence.projectionSha256 };
}
