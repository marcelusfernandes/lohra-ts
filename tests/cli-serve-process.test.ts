import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address !== "object" || address === null) {
        probe.close();
        reject(new Error("PORT_ALLOCATION_FAILED"));
        return;
      }
      probe.close((error) => {
        if (error !== undefined) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitFor(
  check: () => boolean,
  failure: () => Error | null,
  timeoutMs = 8_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    const error = failure();
    if (error !== null) throw error;
    if (Date.now() - startedAt >= timeoutMs) throw new Error("SERVE_PROCESS_TIMEOUT");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

interface ProcessObservation {
  readonly status: number;
  readonly body: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

async function observeServeProcess(
  buildArgs: (port: number) => readonly string[],
): Promise<ProcessObservation> {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "lohra-serve-parser-process-"));
  const home = join(runtimeRoot, "home");
  const port = await allocatePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve(root, "src/cli.ts"), "serve", ...buildArgs(port)],
    {
      cwd: root,
      env: {
        HOME: home,
        LOHRA_HOME: home,
        LOHRA_PROVIDER: "openai",
        OPENAI_API_KEY: "T11-DUMMY-KEY-NO-LIVE-EGRESS",
        PATH: "/usr/bin:/bin",
        NO_COLOR: "1",
        TZ: "UTC",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const processState: {
    settled: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null } | null;
  } = { settled: null };
  child.once("close", (exitCode, signal) => {
    processState.settled = { exitCode, signal };
  });

  try {
    await waitFor(
      () => Buffer.concat(stderrChunks).toString("utf8").includes("Lohra OpenAI server:"),
      () =>
        processState.settled === null
          ? null
          : new Error(
              `SERVE_PROCESS_EXITED:${String(processState.settled.exitCode)}:${String(processState.settled.signal)}:${Buffer.concat(stderrChunks).toString("utf8")}`,
            ),
    );
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/models`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body = await response.text();
    child.kill("SIGINT");
    await waitFor(
      () => processState.settled !== null,
      () => null,
    );
    return {
      status: response.status,
      body,
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode: processState.settled?.exitCode ?? null,
    };
  } finally {
    if (processState.settled === null) child.kill("SIGKILL");
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

describe("serve CLI parse result reaches the real process configuration", () => {
  const cases: readonly {
    readonly label: string;
    readonly buildArgs: (port: number) => readonly string[];
  }[] = [
    {
      label: "exact options",
      buildArgs: (port) => [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--insecure",
        "--tools",
        "read_file",
      ],
    },
    {
      label: "unambiguous abbreviated options",
      buildArgs: (port) => [
        "--ho",
        "127.0.0.1",
        "--po",
        String(port),
        "--insec",
        "--too",
        "read_file",
      ],
    },
    {
      label: "inline value options",
      buildArgs: (port) => [
        "--host=127.0.0.1",
        `--port=${String(port)}`,
        "--insecure",
        "--tools=read_file",
      ],
    },
  ];

  for (const scenario of cases) {
    it(
      scenario.label,
      async () => {
        const observed = await observeServeProcess(scenario.buildArgs);
        expect(observed.status).toBe(200);
        expect(observed.body).toContain('"object":"list"');
        expect(observed.stderr).toContain("agentic mode — server-side tools enabled: read_file");
        expect(observed.stderr).toContain(
          "--insecure with tools = UNAUTHENTICATED remote code execution",
        );
        expect(observed.stderr).not.toContain("API key:");
        expect(observed.exitCode).toBe(0);
      },
      15_000,
    );
  }
});
