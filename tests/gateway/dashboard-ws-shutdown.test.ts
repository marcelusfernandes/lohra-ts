import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { parseCommand } from "../../src/cli/arg-validation.js";
import { DASHBOARD_SPEC } from "../../src/cli/arg-spec.js";
import { runDashboard } from "../../src/commands/dashboard.js";
import { waitUntilBound } from "../helpers/wait-until-bound.js";

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly port: number;
  readonly done: Promise<number>;
  shutdown(): void;
}

async function startDashboard(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "lohra-ws-shutdown-"));
  const home = join(root, "home");
  const stderrLines: string[] = [];
  const options: Parameters<typeof runDashboard>[0] = {
    flags: parseCommand(DASHBOARD_SPEC, ["--provider", "ollama", "--insecure", "--no-open"])
      .options,
    environment: { LOHRA_HOME: home, LOHRA_PROVIDER: "ollama" },
    home,
    codexHome: join(root, "codex"),
    cwd: root,
    stderr: (text: string) => {
      stderrLines.push(text);
    },
    port: 0,
  };
  const { ready, shutdown } = waitUntilBound(options);
  const done = runDashboard(options);
  await ready;
  const banner = stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
  const port = Number(banner?.match(/:(\d+)\n$/u)?.[1]);
  expect(port).toBeGreaterThan(0);
  let triggered = false;
  return {
    root,
    home,
    port,
    done,
    shutdown: () => {
      if (triggered) return;
      triggered = true;
      shutdown();
    },
  };
}

async function cleanup(fixture: Fixture): Promise<void> {
  fixture.shutdown();
  try {
    const settled = await within(
      fixture.done.then(
        () => true,
        () => true,
      ),
      12_000,
    );
    expect(settled).toBe(true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function openWebSocket(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws`);
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      resolve();
    });
    ws.once("error", reject);
  });
  if ((await within(opened, 3_000)) === "timeout") {
    ws.terminate();
    throw new Error("websocket did not open");
  }
  return ws;
}

function closedWebSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once("close", () => {
      resolve();
    });
  });
}

function assertStateReleased(fixture: Fixture): void {
  const state = join(fixture.home, "state.db");
  expect(existsSync(state)).toBe(true);
  renameSync(state, `${state}.closed`);
}

async function rebind(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe("dashboard shutdown with active WebSockets", () => {
  it("closes one client before client action, then releases port and state", async () => {
    const fixture = await startDashboard();
    let ws: WebSocket | undefined;
    try {
      ws = await openWebSocket(fixture.port);
      const closed = closedWebSocket(ws);
      fixture.shutdown();
      expect(await within(closed, 3_000)).not.toBe("timeout");
      expect(await within(fixture.done, 12_000)).toBe(0);
      await rebind(fixture.port);
      assertStateReleased(fixture);
    } finally {
      ws?.terminate();
      await cleanup(fixture);
    }
  }, 20_000);

  it("closes every connected client rather than waiting for each peer", async () => {
    const fixture = await startDashboard();
    const clients: WebSocket[] = [];
    try {
      for (let i = 0; i < 3; i++) clients.push(await openWebSocket(fixture.port));
      const closed = Promise.all(clients.map(closedWebSocket));
      fixture.shutdown();
      expect(await within(closed, 3_000)).not.toBe("timeout");
      expect(await within(fixture.done, 12_000)).toBe(0);
      assertStateReleased(fixture);
    } finally {
      for (const ws of clients) ws.terminate();
      await cleanup(fixture);
    }
  }, 20_000);

  it("bounds shutdown when an upgraded client ignores the close frame", async () => {
    const fixture = await startDashboard();
    let socket: Socket | undefined;
    try {
      socket = connect(fixture.port, "127.0.0.1");
      const opened = new Promise<void>((resolve, reject) => {
        let response = "";
        socket?.once("connect", () => {
          socket?.write(
            "GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n" +
              "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
          );
        });
        socket?.on("data", (chunk: Buffer) => {
          response += chunk.toString("binary");
          if (response.includes("\r\n\r\n")) {
            expect(response).toContain("HTTP/1.1 101");
            resolve();
          }
        });
        socket?.once("error", reject);
      });
      expect(await within(opened, 3_000)).not.toBe("timeout");
      const closed = new Promise<void>((resolve) => {
        socket?.once("close", () => {
          resolve();
        });
      });
      fixture.shutdown();
      expect(await within(closed, 4_000)).not.toBe("timeout");
      expect(await within(fixture.done, 12_000)).toBe(0);
      assertStateReleased(fixture);
    } finally {
      socket?.destroy();
      await cleanup(fixture);
    }
  }, 20_000);

  it("preserves a socket close error after closing the listener and state", async () => {
    const fixture = await startDashboard();
    const ws = await openWebSocket(fixture.port);
    const cause = new Error("websocket close failed in fixture");
    const close = vi.spyOn(WebSocket.prototype, "close").mockImplementationOnce(() => {
      throw cause;
    });
    try {
      const closed = closedWebSocket(ws);
      const outcomePromise = fixture.done.then(
        () => "resolved",
        (error: unknown) => error,
      );
      fixture.shutdown();
      expect(await within(closed, 3_000)).not.toBe("timeout");
      const outcome = await within(outcomePromise, 12_000);
      expect(outcome).toBe(cause);
      await rebind(fixture.port);
      assertStateReleased(fixture);
    } finally {
      close.mockRestore();
      ws.terminate();
      await cleanup(fixture);
    }
  }, 20_000);

  it("reports both socket and WebSocket server cleanup failures", async () => {
    const fixture = await startDashboard();
    const ws = await openWebSocket(fixture.port);
    const socketCause = new Error("socket close failed in fixture");
    const serverCause = new Error("WebSocket server close failed in fixture");
    const closeSocket = vi.spyOn(WebSocket.prototype, "close").mockImplementationOnce(() => {
      throw socketCause;
    });
    const closeServer = vi
      .spyOn(WebSocketServer.prototype, "close")
      .mockImplementationOnce((done) => {
        done?.(serverCause);
        return undefined;
      });
    try {
      const outcomePromise = fixture.done.then(
        () => "resolved",
        (error: unknown) => error,
      );
      fixture.shutdown();
      const outcome = await within(outcomePromise, 12_000);
      expect(outcome).toBeInstanceOf(AggregateError);
      expect((outcome as AggregateError).errors).toEqual([socketCause, serverCause]);
      await rebind(fixture.port);
      assertStateReleased(fixture);
    } finally {
      closeSocket.mockRestore();
      closeServer.mockRestore();
      ws.terminate();
      await cleanup(fixture);
    }
  }, 20_000);
});
