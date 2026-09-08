// Issue #221: LOHRA_DASHBOARD_SESSION_TOKEN="" produced an empty
// `expectedToken`, and `timingSafeTokenEqual("", "")` (before this fix)
// returned true -- with #4's non-loopback `--host`, this opened the gateway
// on the network with no real authentication. This file proves the CLI
// refuses an empty (or whitespace-only) token before any bind, exit 2, with
// its own CLI-shaped error, mirroring the `--insecure`/non-loopback refusal
// already covered by `tests/dashboard-host.test.ts`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDashboard, type DashboardCommandOptions } from "../src/commands/dashboard.js";
import { sendRawHttpRequest } from "./support/parity/gateway/raw-http-client.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-dashboard-token-"));
  roots.push(root);
  return root;
}

function baseOptions(overrides: Partial<DashboardCommandOptions> = {}) {
  const home = tempHome();
  const stderrLines: string[] = [];
  return {
    argv: ["--provider", "anthropic", "--host", "::1"],
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

// Refused starts (bad token) resolve before ever calling
// `registerShutdownTrigger` (dashboard.ts wires it up only after a
// successful bind); a good start blocks on it until shutdown is signaled.
// This helper covers both without the test ever hanging: it always captures
// the shutdown handler if one is registered, waits briefly, then fires it
// unconditionally before awaiting the result.
async function runToCompletion(
  options: ReturnType<typeof baseOptions>,
): Promise<{ readonly code: number }> {
  let shutdown: (() => void) | undefined;
  options.registerShutdownTrigger = (handler: () => void) => {
    shutdown = handler;
  };
  const donePromise = runDashboard(options);
  await sleep(150);
  shutdown?.();
  const code = await donePromise;
  return { code };
}

describe("runDashboard: refuses an empty session token on the network (issue #221 AC)", () => {
  it("exits 2 with a CLI-shaped error, never announcing a bound port, for an empty token", async () => {
    const options = baseOptions({
      environment: { ANTHROPIC_API_KEY: "sk-test-key", LOHRA_DASHBOARD_SESSION_TOKEN: "" },
    });
    const { code } = await runToCompletion(options);
    expect(code).toBe(2);
    const stderr = options.stderrLines.join("");
    expect(stderr).toContain("usage: lohra dashboard");
    expect(stderr).toContain("LOHRA_DASHBOARD_SESSION_TOKEN vazio");
    expect(stderr).toContain("gere um token");
    expect(options.stderrLines.some((line) => line.startsWith("Lohra dashboard:"))).toBe(false);
  });

  it("exits 2 with a CLI-shaped error, never announcing a bound port, for a whitespace-only token", async () => {
    const options = baseOptions({
      environment: { ANTHROPIC_API_KEY: "sk-test-key", LOHRA_DASHBOARD_SESSION_TOKEN: "   " },
    });
    const { code } = await runToCompletion(options);
    expect(code).toBe(2);
    const stderr = options.stderrLines.join("");
    expect(stderr).toContain("usage: lohra dashboard");
    expect(stderr).toContain("LOHRA_DASHBOARD_SESSION_TOKEN vazio");
    expect(stderr).toContain("gere um token");
    expect(options.stderrLines.some((line) => line.startsWith("Lohra dashboard:"))).toBe(false);
  });

  it("does NOT refuse when the variable is simply unset (a token is generated)", async () => {
    const options = baseOptions();
    const { code } = await runToCompletion(options);
    expect(code).toBe(0);
    expect(options.stderrLines.some((line) => line.includes("lohra: error:"))).toBe(false);
  });

  it("does NOT refuse a non-empty, non-whitespace token", async () => {
    const options = baseOptions({
      environment: {
        ANTHROPIC_API_KEY: "sk-test-key",
        LOHRA_DASHBOARD_SESSION_TOKEN: "a-real-token",
      },
    });
    const { code } = await runToCompletion(options);
    expect(code).toBe(0);
    expect(options.stderrLines.some((line) => line.includes("lohra: error:"))).toBe(false);
  });
});

// Follow-up from the #223 review: every test above only proves the CLI
// refuses a bad/empty *env var*, never that the token it ends up enforcing
// IS that env var's value -- a mutant that dropped `rawToken` and always
// called `generateSessionToken()` on its own would still pass all of them
// (a token is still generated, still non-empty, dashboard still boots).
// This proves identity: boot with a known `LOHRA_DASHBOARD_SESSION_TOKEN`,
// then show over a real socket that exactly that value authenticates
// `/api/status` and a different value does not.
describe("runDashboard: LOHRA_DASHBOARD_SESSION_TOKEN is the token actually enforced (issue #222 follow-up)", () => {
  it("the printed WS line carries the exact configured token, and only that token authenticates /api/status", async () => {
    const knownToken = "known-fixed-token-222";
    const options = baseOptions({
      argv: ["--provider", "anthropic", "--host", "127.0.0.1"],
      environment: {
        ANTHROPIC_API_KEY: "sk-test-key",
        LOHRA_DASHBOARD_SESSION_TOKEN: knownToken,
      },
    });
    let shutdown: (() => void) | undefined;
    options.registerShutdownTrigger = (handler: () => void) => {
      shutdown = handler;
    };
    const donePromise = runDashboard(options);
    await sleep(150);

    const boundLine = options.stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
    const port = Number(boundLine?.match(/:(\d+)\n$/)?.[1]);
    const wsLine = options.stderrLines.find((line) => line.startsWith("WebSocket:"));
    expect(wsLine).toContain(`token=${knownToken}`);

    const good = await sendRawHttpRequest("127.0.0.1", port, {
      method: "GET",
      path: "/api/status",
      headers: [
        ["Host", "127.0.0.1"],
        ["X-Lohra-Session-Token", knownToken],
        ["Connection", "close"],
      ],
    });
    expect(good.status).toBe(200);

    const bad = await sendRawHttpRequest("127.0.0.1", port, {
      method: "GET",
      path: "/api/status",
      headers: [
        ["Host", "127.0.0.1"],
        ["X-Lohra-Session-Token", "not-the-configured-token"],
        ["Connection", "close"],
      ],
    });
    expect(bad.status).toBe(401);

    shutdown?.();
    await donePromise;
  });
});
