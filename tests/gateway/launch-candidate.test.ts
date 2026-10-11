import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  candidateDashboardPortFromStderr,
  launchCandidateDashboard,
  type LaunchedGatewayProcess,
} from "../support/parity/gateway/launch-candidate.js";
import { sendRawHttpRequest } from "../support/parity/gateway/raw-http-client.js";
import { connectRawWs, WS_OPCODE } from "../support/parity/gateway/raw-ws-client.js";
import { VERSION } from "../../src/version.js";

// This is the first genuinely [processo-ts] + [socket-bilateral]-shaped
// test in this session: a real, separately spawned `lohra dashboard`
// process (via tsx against source, not in-process), probed with nothing
// but hand-rolled HTTP/RFC6455 sockets. No TestClient, no ws library, no
// direct function calls into the server module.

const roots: string[] = [];
let activeProcess: LaunchedGatewayProcess | null = null;

async function within<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(label));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

afterEach(async () => {
  const failures: unknown[] = [];
  if (activeProcess !== null) {
    const owned = activeProcess;
    activeProcess = null;
    try {
      const stopping = owned.kill("SIGKILL");
      try {
        await within(stopping, 3_000, "DASHBOARD_CLEANUP_TIMEOUT");
      } catch (firstError) {
        try {
          process.kill(owned.pid, "SIGKILL");
          await within(stopping, 2_000, "DASHBOARD_CLEANUP_FALLBACK_TIMEOUT");
        } catch (fallbackError) {
          failures.push(new AggregateError([firstError, fallbackError], "owned dashboard cleanup"));
        }
      }
    } catch (error) {
      failures.push(error);
    }
  }
  while (roots.length > 0) {
    const root = roots.pop() as string;
    try {
      rmSync(root, { recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "dashboard fixture cleanup");
}, 15_000);

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-launch-candidate-"));
  roots.push(root);
  return root;
}

async function rebindReleasedPort(port: number): Promise<void> {
  const server = createServer();
  let bindError: unknown;
  try {
    await within(
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      }),
      3_000,
      "DASHBOARD_REBIND_TIMEOUT",
    );
  } catch (error) {
    bindError = error;
  }
  try {
    await within(
      new Promise<void>((resolve, reject) => {
        server.close((error: NodeJS.ErrnoException | undefined) => {
          if (error === undefined || error.code === "ERR_SERVER_NOT_RUNNING") resolve();
          else reject(error);
        });
      }),
      3_000,
      "DASHBOARD_REBIND_CLOSE_TIMEOUT",
    );
  } catch (closeError) {
    if (bindError !== undefined)
      throw new AggregateError([bindError, closeError], "dashboard rebind", { cause: closeError });
    throw closeError;
  }
  if (bindError instanceof Error) throw bindError;
  if (bindError !== undefined) throw new Error("dashboard rebind failed", { cause: bindError });
}

describe("launchCandidateDashboard: a real subprocess, probed over raw sockets", () => {
  it("detects the dashboard boot line when later stderr shares the same chunk", () => {
    expect(
      candidateDashboardPortFromStderr(
        "Lohra dashboard: http://127.0.0.1:55775\nWebSocket:       ws://127.0.0.1:55775/api/ws\n",
      ),
    ).toBe(55_775);
  });

  it("boots, serves authenticated REST, and completes a real RFC6455 WS handshake", async () => {
    const home = tempHome();
    const process_ = await launchCandidateDashboard({
      argv: ["--provider", "anthropic", "--insecure"],
      env: {
        // The launcher must use the project's pinned tsx entry point rather
        // than discovering `npx` (or another runtime shim) through PATH.
        PATH: join(home, "no-runtime-tools"),
        HOME: home,
        LOHRA_HOME: home,
        ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
      },
      cwd: home,
      bootTimeoutMs: 20_000,
    });
    activeProcess = process_;

    const restResponse = await sendRawHttpRequest("127.0.0.1", process_.port, {
      method: "GET",
      path: "/api/status",
      headers: [
        ["Host", "127.0.0.1"],
        ["Connection", "close"],
      ],
    });
    expect(restResponse.status).toBe(200);
    const body = JSON.parse(restResponse.body.toString("utf8")) as { ok: boolean; version: string };
    expect(body).toEqual({ ok: true, version: VERSION, sessions: 0 });

    const wsClient = await connectRawWs("127.0.0.1", process_.port, "/api/ws");
    expect(wsClient.handshake.status).toBe(101);
    const readyFrame = await wsClient.nextFrame();
    expect(readyFrame.opcode).toBe(WS_OPCODE.text);
    const readyEvent = JSON.parse(readyFrame.payload.toString("utf8")) as {
      params: { type: string };
    };
    expect(readyEvent.params.type).toBe("gateway.ready");
    wsClient.close();

    const result = await process_.kill("SIGINT");
    activeProcess = null;
    expect(result).toEqual(
      process.platform === "win32"
        ? { exitCode: null, signal: "SIGINT" }
        : { exitCode: 0, signal: null },
    );
    await rebindReleasedPort(process_.port);
    rmSync(home, { recursive: true });
    expect(existsSync(home)).toBe(false);
    roots.splice(roots.indexOf(home), 1);
  }, 30_000);
});
