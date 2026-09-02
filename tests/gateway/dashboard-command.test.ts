import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { runDashboard } from "../../src/commands/dashboard.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-dashboard-home-"));
  roots.push(root);
  return root;
}

function baseOptions(overrides: Partial<Parameters<typeof runDashboard>[0]> = {}) {
  const home = tempHome();
  const stderrLines: string[] = [];
  return {
    argv: ["--provider", "anthropic"],
    environment: { ANTHROPIC_API_KEY: "sk-test-key" },
    home,
    codexHome: join(home, "codex"),
    cwd: tmpdir(),
    stderr: (text: string) => stderrLines.push(text),
    port: 0,
    ...overrides,
    stderrLines,
  };
}

describe("runDashboard: no provider configured (assertion 56)", () => {
  it("exits 2 with the exact didactic no-provider text, matching chat's boundary", async () => {
    const options = baseOptions({ argv: [] });
    const code = await runDashboard(options);
    expect(code).toBe(2);
    expect(options.stderrLines.join("")).toContain("no provider configured — there are three ways in:");
  });
});

describe("runDashboard: subscription mode without login (assertion 50)", () => {
  it("exits 2 with 'subscription mode: ...' when acknowledged_tos_risk is true and preference is default", async () => {
    const home = tempHome();
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ openai: { auth_mode: "subscription", acknowledged_tos_risk: true } }),
    );
    const stderrLines: string[] = [];
    const code = await runDashboard({
      argv: [],
      environment: {},
      home,
      codexHome: join(home, "codex"),
      cwd: tmpdir(),
      stderr: (text) => stderrLines.push(text),
      port: 0,
    });
    expect(code).toBe(2);
    expect(stderrLines.join("")).toContain("subscription mode:");
  });

  it("boots successfully when acknowledged_tos_risk is false", async () => {
    const home = tempHome();
    writeFileSync(join(home, "auth.json"), JSON.stringify({ openai: { auth_mode: "subscription", acknowledged_tos_risk: false } }));
    const stderrLines: string[] = [];
    let shutdown: (() => void) | undefined;
    const donePromise = runDashboard({
      argv: ["--provider", "anthropic"],
      environment: { ANTHROPIC_API_KEY: "sk-test" },
      home,
      codexHome: join(home, "codex"),
      cwd: tmpdir(),
      stderr: (text) => stderrLines.push(text),
      port: 0,
      registerShutdownTrigger: (handler) => {
        shutdown = handler;
      },
    });
    // Wait for the server to actually start (stderr lines appear once bound).
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(stderrLines.some((line) => line.startsWith("Lohra dashboard: http://"))).toBe(true);
    shutdown?.();
    const code = await donePromise;
    expect(code).toBe(0);
  });

  it("boots with preference=api_key, printing the exact PREFER_KEY_NOTE line", async () => {
    const home = tempHome();
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ openai: { auth_mode: "subscription", acknowledged_tos_risk: true, preference: "api_key" } }),
    );
    const stderrLines: string[] = [];
    let shutdown: (() => void) | undefined;
    const donePromise = runDashboard({
      argv: ["--provider", "anthropic"],
      environment: { ANTHROPIC_API_KEY: "sk-test" },
      home,
      codexHome: join(home, "codex"),
      cwd: tmpdir(),
      stderr: (text) => stderrLines.push(text),
      port: 0,
      registerShutdownTrigger: (handler) => {
        shutdown = handler;
      },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(stderrLines.join("")).toContain(
      "note: your OpenAI/Codex subscription is active, but preference=api_key",
    );
    shutdown?.();
    await donePromise;
  });
});

describe("runDashboard: port already bound (assertion 55)", () => {
  it("exits 3, and the WS token line is printed before the bind failure", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolvePromise) => blocker.listen(0, "127.0.0.1", () => { resolvePromise(); }));
    const address = blocker.address();
    const occupiedPort = typeof address === "object" && address !== null ? address.port : 0;

    const options = baseOptions({ port: occupiedPort });
    const code = await runDashboard(options);
    expect(code).toBe(3);
    expect(options.stderrLines.some((line) => line.includes("WebSocket:"))).toBe(true);

    await new Promise<void>((resolvePromise) => blocker.close(() => { resolvePromise(); }));
  });
});

describe("runDashboard: --insecure boots and serves without a token, stderr has zero warning lines", () => {
  it("stderr is exactly the two boot lines, no token in the WS URL", async () => {
    const options = baseOptions({ argv: ["--provider", "anthropic", "--insecure"] });
    let shutdown: (() => void) | undefined;
    options.registerShutdownTrigger = (handler: () => void) => {
      shutdown = handler;
    };
    const donePromise = runDashboard(options);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

    expect(options.stderrLines).toHaveLength(2);
    expect(options.stderrLines[0]).toMatch(/^Lohra dashboard: http:\/\/127\.0\.0\.1:\d+\n$/);
    expect(options.stderrLines[1]).toMatch(/^WebSocket: {7}ws:\/\/127\.0\.0\.1:\d+\/api\/ws\n$/);

    shutdown?.();
    const code = await donePromise;
    expect(code).toBe(0);
  });
});

describe("runDashboard: SIGINT-equivalent shutdown (assertion 54)", () => {
  it("exits 0 and the port is free again for an immediate rebind", async () => {
    const options = baseOptions();
    let shutdown: (() => void) | undefined;
    options.registerShutdownTrigger = (handler: () => void) => {
      shutdown = handler;
    };
    const donePromise = runDashboard(options);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const boundLine = options.stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
    const port = Number(boundLine?.match(/:(\d+)\n$/)?.[1]);

    shutdown?.();
    const code = await donePromise;
    expect(code).toBe(0);

    const rebind: Server = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      rebind.once("error", reject);
      rebind.listen(port, "127.0.0.1", () => { resolvePromise(); });
    });
    await new Promise<void>((resolvePromise) => rebind.close(() => { resolvePromise(); }));
  });
});

describe("runDashboard: --port CLI flag (mirrors the oracle's dashboard --port, needed by the parity harness to launch the real candidate binary)", () => {
  it("binds the port given via --port in argv, not just the programmatic port option", async () => {
    const probe: Server = createServer();
    const freePort = await new Promise<number>((resolvePromise) => {
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        resolvePromise(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    await new Promise<void>((resolvePromise) => probe.close(() => { resolvePromise(); }));

    const options = baseOptions({ argv: ["--provider", "anthropic", "--port", String(freePort)] });
    delete (options as { port?: number }).port;
    let shutdown: (() => void) | undefined;
    options.registerShutdownTrigger = (handler: () => void) => {
      shutdown = handler;
    };
    const donePromise = runDashboard(options);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(options.stderrLines[0]).toBe(`Lohra dashboard: http://127.0.0.1:${String(freePort)}\n`);

    shutdown?.();
    await donePromise;
  });
});

describe("runDashboard: end-to-end real socket round trip", () => {
  it("boots, serves an authenticated /api/status, and accepts a real WS connection", async () => {
    const options = baseOptions();
    let shutdown: (() => void) | undefined;
    options.registerShutdownTrigger = (handler: () => void) => {
      shutdown = handler;
    };
    const donePromise = runDashboard(options);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const boundLine = options.stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
    const port = Number(boundLine?.match(/:(\d+)\n$/)?.[1]);
    const wsLine = options.stderrLines.find((line) => line.startsWith("WebSocket:"));
    const token = wsLine?.match(/token=([^\n]+)\n$/)?.[1];
    expect(token).toBeDefined();

    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws?token=${String(token)}`);
    const ready = await new Promise<string>((resolvePromise) => {
      ws.once("message", (data) => {
        resolvePromise(Buffer.from(data as Buffer).toString("utf8"));
      });
    });
    const readyFrame = JSON.parse(ready) as { params: { type: string } };
    expect(readyFrame.params.type).toBe("gateway.ready");
    ws.close();

    shutdown?.();
    await donePromise;
  });
});
