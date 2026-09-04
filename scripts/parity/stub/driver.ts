import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";

import { startStub } from "./server.js";
import type { StubDriverConfig, StubRuntime } from "./types.js";

function initialize(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  closeSync(openSync(path, "w"));
}

async function close(server: Awaited<ReturnType<typeof startStub>> | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeAllConnections();
  });
}

async function runTarget(config: StubDriverConfig, activePort: number): Promise<number> {
  const targetEnvironment: Record<string, string> = { ...config.target.environment };
  if (config.port !== undefined) {
    targetEnvironment.LOHRA_PROVIDER_BASE_URL = `http://localhost:${String(activePort)}/v1`;
    targetEnvironment.LOHRA_OLLAMA_CONNECT_URL = `http://localhost:${String(activePort)}/api/tags`;
    if (config.side === "oracle") {
      const inheritedPythonPath = targetEnvironment.PYTHONPATH ?? "";
      targetEnvironment.PYTHONDONTWRITEBYTECODE = "1";
      targetEnvironment.LOHRA_PARITY_ORIGINAL_PYTHONPATH = inheritedPythonPath;
      targetEnvironment.PYTHONPATH = [
        join(import.meta.dirname, "python-sitecustomize"),
        inheritedPythonPath,
      ]
        .filter((entry) => entry.length > 0)
        .join(delimiter);
    }
  }
  const child = spawn(config.target.executable, [...config.target.argv], {
    cwd: config.target.cwd,
    env: targetEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });
  let outcome: "running" | "timeout" | "output-limit" = "running";
  const terminate = (next: Exclude<typeof outcome, "running">): void => {
    if (outcome !== "running") return;
    outcome = next;
    if (child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const forward = (source: NodeJS.ReadableStream, destination: NodeJS.WritableStream): void => {
    let bytes = 0;
    source.on("data", (value: Buffer) => {
      bytes += value.length;
      if (bytes > config.limits.maxOutputBytes) {
        terminate("output-limit");
        return;
      }
      destination.write(value);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  return await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      terminate("timeout");
    }, config.limits.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (outcome === "timeout") resolve(88);
      else if (outcome === "output-limit") resolve(89);
      else if (signal !== null) reject(new Error(`target terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function main(): Promise<number> {
  const path = process.argv[2];
  if (path === undefined) throw new Error("stub driver config path is required");
  const config = JSON.parse(readFileSync(path, "utf8")) as StubDriverConfig;
  for (const log of Object.values(config.logs)) initialize(log);
  const runtime: StubRuntime = {
    fixture: config.stub.fixture,
    state: config.stub.state,
    scenario: config.scenario,
    side: config.side,
    comparedHeaders: config.stub.requestLog.comparedHeaders,
    excludedHeaders: config.stub.requestLog.excludedHeaders,
    projectedLog: config.logs.projected,
    rawLog: config.logs.raw,
    failures: [],
    sequence: [],
    toolSequence: config.stub.toolSequence ?? [],
    laneSteps: config.stub.laneSteps ?? {},
    laneStepIndex: new Map(),
    latches: new Map(),
    activePort: 11_434,
    posts: 0,
    requests: 0,
  };
  let server: Awaited<ReturnType<typeof startStub>> | undefined;
  let activePort = config.port ?? 11_434;
  try {
    if (config.stub.state !== "down") {
      try {
        server = await startStub(runtime, config.port ?? 11_434);
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("stub address missing");
        activePort = address.port;
        runtime.activePort = activePort;
      } catch {
        return 86;
      }
    } else if (config.port === 0) {
      throw new Error("dynamic stub port requires a listening stub");
    }
    return await runTarget(config, activePort);
  } finally {
    await close(server);
    writeFileSync(
      config.logs.summary,
      JSON.stringify({
        gets: runtime.sequence.filter((entry) => entry.startsWith("GET ")).length,
        posts: runtime.posts,
        sequence: runtime.sequence,
      }),
    );
    writeFileSync(
      config.logs.assertions,
      JSON.stringify({ valid: runtime.failures.length === 0, failures: runtime.failures }),
    );
  }
}

try {
  process.exitCode = await main();
} catch {
  process.exitCode = 87;
}
