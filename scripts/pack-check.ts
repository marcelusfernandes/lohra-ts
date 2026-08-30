#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { startStub } from "./parity/stub/server.js";
import type { StubRuntime } from "./parity/stub/types.js";

function command(
  executable: string,
  argv: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(executable, [...argv], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `PACK_COMMAND_FAILED:${executable}:${String(result.status ?? result.signal ?? "unknown")}:${result.stderr}`,
    );
  return result;
}

async function commandAsync(
  executable: string,
  argv: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return await new Promise<{ readonly stdout: string; readonly stderr: string }>(
    (resolveCommand, reject) => {
      const child = spawn(executable, [...argv], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 15_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) resolveCommand({ stdout, stderr });
        else
          reject(
            new Error(
              `PACK_COMMAND_FAILED:${executable}:${String(code ?? signal ?? "unknown")}:${stderr}`,
            ),
          );
      });
    },
  );
}

async function portClosed(): Promise<boolean> {
  return await new Promise((resolvePort) => {
    const socket = createConnection({ host: "127.0.0.1", port: 11_434 });
    socket.once("connect", () => {
      socket.destroy();
      resolvePort(false);
    });
    socket.once("error", () => {
      resolvePort(true);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolvePort(false);
    });
  });
}

const root = mkdtempSync(join(tmpdir(), "lohra-t08-pack-"));
let server: Awaited<ReturnType<typeof startStub>> | undefined;
try {
  if (!(await portClosed())) throw new Error("PRECONDITION_PORT_IN_USE");
  const packDirectory = join(root, "pack");
  const installDirectory = join(root, "install");
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(installDirectory, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });

  const packed = command("npm", ["pack", "--json", "--pack-destination", packDirectory]);
  const packResult = JSON.parse(packed.stdout) as readonly { filename: string }[];
  const filename = packResult[0]?.filename;
  if (filename === undefined) throw new Error("PACK_TARBALL_MISSING");
  const tarball = join(packDirectory, filename);
  command("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installDirectory,
    tarball,
  ]);

  const projected = join(root, "requests.jsonl");
  const raw = join(root, "requests-raw.jsonl");
  const runtime: StubRuntime = {
    fixture: "chat-text",
    state: "up-with-models",
    scenario: "t08-package-smoke",
    side: "candidate",
    comparedHeaders: ["authorization", "accept", "content-type", "host", "x-stainless-retry-count"],
    excludedHeaders: [
      "accept-encoding",
      "connection",
      "content-length",
      "user-agent",
      "x-stainless-lang",
      "x-stainless-package-version",
      "x-stainless-os",
      "x-stainless-arch",
      "x-stainless-runtime",
      "x-stainless-runtime-version",
      "x-stainless-async",
      "x-stainless-read-timeout",
    ],
    projectedLog: projected,
    rawLog: raw,
    failures: [],
    sequence: [],
    posts: 0,
    requests: 0,
  };
  server = await startStub(runtime);
  const bin = resolve(installDirectory, "node_modules/.bin/lohra");
  if (!existsSync(bin)) throw new Error("PACK_BIN_MISSING");
  const isolatedEnvironment: NodeJS.ProcessEnv = {
    PATH: `${dirname(process.execPath)}:/bin`,
    HOME: home,
    LOHRA_HOME: join(home, ".lohra"),
    CODEX_HOME: join(home, "codex"),
    TMPDIR: join(home, "tmp"),
    TZ: "UTC",
    NO_COLOR: "1",
    COLUMNS: "80",
    LOHRA_NO_WIZARD: "1",
  };
  const version = command(bin, ["--version"], { cwd: project, env: isolatedEnvironment });
  if (version.stdout !== "lohra 0.0.11\n") throw new Error("PACK_VERSION_MISMATCH");
  const turn = await commandAsync(
    bin,
    [
      "chat",
      "package smoke",
      "--json",
      "--no-tools",
      "--provider",
      "ollama",
      "--model",
      "stub-coder:1b",
    ],
    { cwd: project, env: isolatedEnvironment },
  );
  const envelope = JSON.parse(turn.stdout) as { completed?: unknown };
  if (envelope.completed !== true || runtime.posts !== 1 || runtime.failures.length > 0)
    throw new Error("PACK_CHAT_MISMATCH");
  if (readFileSync(projected, "utf8").length === 0) throw new Error("PACK_REQUEST_LOG_EMPTY");
  process.stdout.write(
    `${JSON.stringify({ packed: true, version: true, publicTurn: true, pythonOnPath: false, posts: runtime.posts })}\n`,
  );
} finally {
  if (server !== undefined) {
    const activeServer = server;
    await new Promise<void>((resolveClose, reject) => {
      activeServer.close((error) => {
        if (error === undefined) resolveClose();
        else reject(error);
      });
      activeServer.closeAllConnections();
    });
  }
  rmSync(root, { recursive: true, force: true });
}
