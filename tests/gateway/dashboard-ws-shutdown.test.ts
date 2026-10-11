import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

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

describe("dashboard shutdown with an active WebSocket", () => {
  it("closes the socket after the shutdown trigger without requiring the client to close it", async () => {
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
      stderr: (text: string) => stderrLines.push(text),
      port: 0,
    };
    const { ready, shutdown } = waitUntilBound(options);
    const done = runDashboard(options);
    let ws: WebSocket | undefined;
    try {
      await ready;
      const banner = stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
      const port = Number(banner?.match(/:(\d+)\n$/u)?.[1]);
      expect(port).toBeGreaterThan(0);
      ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws`);
      const opened = new Promise<void>((resolve, reject) => {
        ws?.once("open", () => {
          resolve();
        });
        ws?.once("error", reject);
      });
      expect(await within(opened, 3_000)).not.toBe("timeout");
      const closed = new Promise<void>((resolve) => {
        ws?.once("close", () => {
          resolve();
        });
      });

      shutdown();

      expect(await within(closed, 3_000)).not.toBe("timeout");
      expect(await within(done, 12_000)).toBe(0);
    } finally {
      ws?.terminate();
      shutdown();
      await within(done, 12_000);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
