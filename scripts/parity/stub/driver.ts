import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

async function runTarget(config: StubDriverConfig): Promise<number> {
  const child = spawn(config.target.executable, [...config.target.argv], {
    cwd: config.target.cwd,
    env: { ...config.target.environment },
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
    posts: 0,
    requests: 0,
  };
  let server: Awaited<ReturnType<typeof startStub>> | undefined;
  try {
    if (config.stub.state !== "down") {
      try {
        server = await startStub(runtime);
      } catch {
        return 86;
      }
    }
    return await runTarget(config);
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
