import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const project = resolve(import.meta.dirname, "../../..");
const root = mkdtempSync(join(tmpdir(), "lohra-t22-no-python-"));
const evidenceDirectory = join(project, ".parity-evidence", "t22");
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("NPM_EXEC_PATH_MISSING");
const npmCache = spawnSync(process.execPath, [npmCli, "config", "get", "cache"], {
  cwd: project,
  env: process.env,
  encoding: "utf8",
}).stdout.trim();
if (npmCache.length === 0) throw new Error("NPM_CACHE_MISSING");

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  executable: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd ?? project,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function filesUnder(directory: string): readonly string[] {
  const output: string[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) output.push(path);
    }
  };
  visit(directory);
  return output.sort();
}

function assertOk(label: string, result: RunResult): void {
  if (result.status !== 0) {
    throw new Error(`${label}:${String(result.status)}:${result.stderr || result.stdout}`);
  }
}

try {
  const shims = join(root, "shims");
  const counter = join(root, "python-attempts.log");
  mkdirSync(shims, { recursive: true });
  const forbiddenExecutables = ["python", "python3", "pip", "pip3", "uv", "poetry"] as const;
  for (const name of forbiddenExecutables) {
    const path = join(shims, name);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(name)} >> ${JSON.stringify(counter)}\nexit 97\n`,
    );
    chmodSync(path, 0o755);
  }
  const safePath = `${shims}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const environment: NodeJS.ProcessEnv = {
    PATH: safePath,
    HOME: join(root, "home"),
    LOHRA_HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    TZ: "UTC",
    NO_COLOR: "1",
    LOHRA_NO_WIZARD: "1",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_cache: npmCache,
  };
  mkdirSync(environment.HOME as string, { recursive: true });
  mkdirSync(environment.TMPDIR as string, { recursive: true });

  const packed = run(process.execPath, [npmCli, "pack", "--json", "--pack-destination", root], {
    env: environment,
  });
  assertOk("PACK", packed);
  const packRows = JSON.parse(packed.stdout) as readonly {
    readonly filename: string;
    readonly shasum: string;
    readonly files: readonly { readonly path: string }[];
  }[];
  const pack = packRows[0];
  if (pack === undefined) throw new Error("PACK_OUTPUT_EMPTY");
  const tarball = join(root, pack.filename);
  const entries = pack.files.map((file) => file.path).sort();
  const forbiddenEntry = entries.find(
    (entry) =>
      entry.endsWith(".py") ||
      /(?:^|\/)(?:backend|oracle|\.oracle-venv|venv|src|tests)(?:\/|$)/u.test(entry) ||
      (entry.startsWith("scripts/") && entry !== "scripts/postinstall.mjs") ||
      entry.startsWith("docs/reference/"),
  );
  if (forbiddenEntry !== undefined) throw new Error(`TARBALL_FORBIDDEN:${forbiddenEntry}`);

  const invocation =
    /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["'](?:python3?|pip3?|uv|poetry)["']/u;
  const scanned = [
    ...filesUnder(join(project, "src")),
    ...filesUnder(join(project, "dist")),
  ].filter((path) => /\.(?:js|mjs|cjs|ts)$/u.test(path));
  const invocationHit = scanned.find((path) => invocation.test(readFileSync(path, "utf8")));
  if (invocationHit !== undefined) {
    throw new Error(`STATIC_PYTHON_INVOCATION:${relative(project, invocationHit)}`);
  }
  const packageJson = JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const lifecycle = Object.entries(packageJson.scripts ?? {}).filter(([name]) =>
    /^(?:pre|post)?(?:install|pack|prepare|publish)$/u.test(name),
  );
  const forbiddenLifecycle = lifecycle.find(([, command]) =>
    /(?:^|[;&|]\s*)(?:python3?|pip3?|uv|poetry)(?:\s|$)/u.test(command),
  );
  if (forbiddenLifecycle !== undefined)
    throw new Error(`LIFECYCLE_PYTHON:${forbiddenLifecycle[0]}`);
  const subprocessCatalog = scanned
    .filter((path) => /node:(?:child_process)|node-pty/u.test(readFileSync(path, "utf8")))
    .map((path) => relative(project, path));

  const consumer = join(root, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"), '{"name":"fixture","private":true}\n');
  const installed = run(
    process.execPath,
    [npmCli, "install", "--offline", "--no-audit", "--no-fund", tarball],
    { cwd: consumer, env: environment },
  );
  assertOk("FRESH_INSTALL", installed);
  const installedRoot = join(consumer, "node_modules", "lohra-ts");
  const cli = join(installedRoot, "dist", "cli.js");
  const version = run(process.execPath, [cli, "--version"], { cwd: consumer, env: environment });
  assertOk("VERSION", version);
  if (version.stdout.trim() !== "lohra 0.0.11") throw new Error("VERSION_OUTPUT");
  assertOk("HELP", run(process.execPath, [cli, "--help"], { cwd: consumer, env: environment }));
  assertOk(
    "UPDATE_HELP",
    run(process.execPath, [cli, "update", "--help"], { cwd: consumer, env: environment }),
  );
  assertOk(
    "WORKFLOW_LIST",
    run(process.execPath, [cli, "workflow", "list"], { cwd: consumer, env: environment }),
  );
  const updateRefusal = run(process.execPath, [cli, "update", "--check"], {
    cwd: consumer,
    env: environment,
  });
  if (
    updateRefusal.status === 0 ||
    !/not_a_repo|npm/iu.test(updateRefusal.stdout + updateRefusal.stderr)
  ) {
    throw new Error("UPDATE_TARBALL_REFUSAL");
  }

  const composition = run(
    process.execPath,
    [
      join(project, "node_modules", "tsx", "dist", "cli.mjs"),
      join(project, "scripts", "parity", "closeout", "composition.ts"),
    ],
    {
      env: {
        ...environment,
        LOHRA_T22_INSTALLED_ROOT: installedRoot,
        LOHRA_T22_CLI: cli,
        LOHRA_T22_PATH: safePath,
      },
    },
  );
  assertOk("PUBLIC_SWEEP", composition);

  const attempts = (() => {
    try {
      return readFileSync(counter, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  })();
  if (attempts.length !== 0) throw new Error(`PYTHON_CANARY:${attempts.join(",")}`);
  const tarballBytes = readFileSync(tarball);
  const observation = {
    tarball: {
      sha256: createHash("sha256").update(tarballBytes).digest("hex"),
      entries: entries.length,
      forbidden: 0,
    },
    staticClosure: { files: scanned.length, invocations: 0, subprocessCatalog },
    lifecycle: { scripts: lifecycle.map(([name]) => name), invocations: 0 },
    install: { offline: true, scriptsEnabled: true, version: "lohra 0.0.11" },
    publicSweep: {
      cli: true,
      sqlite: true,
      http: true,
      sse: true,
      ws: true,
      workflow: true,
      cron: true,
      tools: true,
      updateRefusal: true,
    },
    pythonCanaryAttempts: 0,
    networkUsed: false,
    credentialsUsed: false,
    liveProviderUsed: false,
    controlPlaneUsed: false,
  };
  const canonical = `${JSON.stringify(observation)}\n`;
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, "no-python.json"), canonical);
  process.stdout.write(
    `${JSON.stringify({ ...observation, digest: createHash("sha256").update(canonical).digest("hex") })}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
