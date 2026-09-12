// Issue #457 (dashboard mirror of #440/PR #455): `src/commands/dashboard.ts`
// never even read `--provider` in the `route.mode === "subscription"`
// branch — worse than chat's old behavior (which at least printed a note):
// the flag was discarded in total silence and `--model` (or the Codex
// default) still went straight to the Responses transport, so a
// `--provider anthropic --model claude-...` invocation with an active
// subscription would still boot and eventually 400 from the provider
// instead of refusing at the boundary.
//
// Fixed the same way as chat.ts (#440, option A): an EXPLICIT `--provider`
// in subscription mode now refuses before `resolveCredentials` — no OAuth
// refresh POST, no bind, no gateway boot at all. `--model` alone (no
// `--provider`) is unaffected and must keep reaching Codex.
//
// PR #455's review pointed out that chat's own zero-network proof relied
// only on stubbing `global.fetch` (the refresh POST's mechanism); it never
// also intercepted `NativeChatHttpPort.prototype.post` (the mechanism an
// actual model call would use). Both `it.each` cases below stub *and* spy
// on both, so a regression that skips the refusal and reaches either
// network surface is caught regardless of which one it happens to hit.
//
// The two describe blocks discriminate base from fixed like
// `chat-subscription-provider-flag.test.ts` does: a token <300s from
// expiring forces the base code path through `resolveCredentials`'s
// refresh branch (a `fetch` POST) before ever reaching a `--provider`
// check that doesn't exist on the base — so on base `fetchMock` HAS been
// called and stderr says "subscription mode: ..." (eventually "lohra auth
// login"), never "lohra auth prefer api_key". On the fix, the guard sits
// ahead of `resolveCredentials`, so neither `fetch` nor `post` is ever
// called and stderr names the actual fix's remedy.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { enable, writeTokens } from "../src/auth/index.js";
import { parseCommand } from "../src/cli/arg-validation.js";
import { DASHBOARD_SPEC } from "../src/cli/arg-spec.js";
import { runDashboard, type DashboardCommandOptions } from "../src/commands/dashboard.js";
import { NativeChatHttpPort } from "../src/transports/index.js";
import { waitUntilBound } from "./helpers/wait-until-bound.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "lohra-t457-dashboard-provider-flag-"));
  roots.push(value);
  return value;
}

interface Fixture {
  readonly base: string;
  readonly home: string;
  readonly codexHome: string;
}

function fixture(): Fixture {
  const base = root();
  const home = join(base, ".lohra");
  const codexHome = join(base, ".codex");
  enable(home);
  return { base, home, codexHome };
}

function baseOptions(
  argv: readonly string[],
  fx: Fixture,
): DashboardCommandOptions & { readonly stderrLines: string[] } {
  const stderrLines: string[] = [];
  return {
    flags: parseCommand(DASHBOARD_SPEC, argv).options,
    // Isolates state.db under this fixture's own root instead of the real
    // `~/.lohra` (`src/config/paths.ts`'s `resolvePaths` falls back to the
    // OS home dir when `HOME` is absent from `environment` — same isolation
    // `chat.ts`'s own subscription test mold, commit 81ece5ba, fixed).
    environment: { HOME: fx.base },
    home: fx.home,
    codexHome: fx.codexHome,
    cwd: fx.base,
    stderr: (text: string) => stderrLines.push(text),
    port: 0,
    stderrLines,
  };
}

async function runToCompletion(
  options: DashboardCommandOptions & { readonly stderrLines: string[] },
): Promise<{ readonly code: number }> {
  let shutdown: (() => void) | undefined;
  const optionsWithTrigger = {
    ...options,
    registerShutdownTrigger: (handler: () => void) => {
      shutdown = handler;
    },
  };
  const donePromise = runDashboard(optionsWithTrigger);
  // A refused start resolves on its own; a good start blocks on shutdown.
  // Wait briefly, then fire the trigger unconditionally (a no-op if the
  // promise already settled) so this never hangs either way.
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 150));
  shutdown?.();
  const code = await donePromise;
  return { code };
}

describe("runDashboard refuses an explicit --provider in subscription mode before any network (issue #457)", () => {
  it.each([
    { label: "--provider alone", argv: ["--provider", "anthropic"] },
    {
      label: "--provider and --model together",
      argv: ["--provider", "anthropic", "--model", "claude-haiku-4-5-20251001"],
    },
  ])("$label: exits 2 citing 'lohra auth prefer api_key', zero network", async ({ argv }) => {
    const fx = fixture();
    writeTokens(fx.home, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accountId: "acct-t457-dummy",
      expiresAt: Date.now() / 1000 + 100, // <300s away: would force a refresh on the base
    });
    const fetchMock = vi.fn(() =>
      Promise.reject(new Error("t457: no network call is allowed for this route")),
    );
    vi.stubGlobal("fetch", fetchMock);
    const postSpy = vi
      .spyOn(NativeChatHttpPort.prototype, "post")
      .mockRejectedValue(new Error("t457: no real network call in tests"));

    const options = baseOptions(argv, fx);
    const { code } = await runToCompletion(options);

    expect(code).toBe(2);
    const stderr = options.stderrLines.join("");
    expect(stderr).toContain("--provider anthropic");
    expect(stderr).toContain("lohra auth prefer api_key");
    // Discriminator: on the base this near-expiring token sends the
    // (silently-continuing) subscription path through resolveCredentials's
    // refresh branch, which POSTs via `fetch`. The fix never gets there.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
    expect(options.stderrLines.some((line) => line.startsWith("Lohra dashboard:"))).toBe(false);
  });
});

describe("runDashboard still routes --model alone (no --provider) to Codex in subscription mode (non-regression, issue #457)", () => {
  it("boots, never refuses, and the configured --model actually reaches the Responses transport", async () => {
    const fx = fixture();
    writeTokens(fx.home, {
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      accountId: "acct-t457-nonregression",
      expiresAt: Date.now() / 1000 + 999_999, // far from expiring: no refresh POST either way
    });
    const fetchMock = vi.fn(() =>
      Promise.reject(new Error("t457: no refresh expected for a fresh token")),
    );
    vi.stubGlobal("fetch", fetchMock);
    const expectedModel = "gpt-5.5-codex-t457-nonregression";
    // Rejecting `post` keeps the actual turn off the real network while
    // still letting us capture exactly what was about to be sent.
    const postSpy = vi
      .spyOn(NativeChatHttpPort.prototype, "post")
      .mockRejectedValue(new Error("t457: no real network call in tests"));

    const options = baseOptions(["--model", expectedModel], fx);
    // `waitUntilBound` mutates `registerShutdownTrigger` onto `options`
    // itself (same mold as tests/gateway/dashboard-command.test.ts), so
    // `runDashboard` below must receive this SAME object.
    const { ready, shutdown } = waitUntilBound(options);
    const donePromise = runDashboard(options);

    await Promise.race([ready, donePromise]);
    expect(options.stderrLines.some((line) => line.startsWith("Lohra dashboard:"))).toBe(true);
    const stderr = options.stderrLines.join("");
    expect(stderr).not.toContain("lohra auth prefer api_key");

    const boundLine = options.stderrLines.find((line) => line.startsWith("Lohra dashboard:"));
    const port = Number(boundLine?.match(/:(\d+)\n$/)?.[1]);
    const wsLine = options.stderrLines.find((line) => line.startsWith("WebSocket:"));
    const token = wsLine?.match(/token=(\S+)\n$/)?.[1];
    expect(port).toBeGreaterThan(0);
    expect(token).toBeDefined();

    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws?token=${String(token)}`);
    const messages: string[] = [];
    const waiters: ((value: string) => void)[] = [];
    ws.on("message", (data) => {
      const text = Buffer.from(data as Buffer).toString("utf8");
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(text);
      else messages.push(text);
    });
    const nextMessage = (): Promise<string> => {
      const queued = messages.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolvePromise) => waiters.push(resolvePromise));
    };

    await nextMessage(); // gateway.ready
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: "create", method: "session.create", params: {} }));
    const created = JSON.parse(await nextMessage()) as { result: { session_id: string } };
    await nextMessage(); // session.info
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "submit",
        method: "prompt.submit",
        params: { session_id: created.result.session_id, text: "oi" },
      }),
    );

    // Bounded wait for the model call to actually reach NativeChatHttpPort
    // (the turn then fails, since post is mocked to reject -- that failure
    // is expected and irrelevant here).
    const deadline = Date.now() + 5_000;
    while (postSpy.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }

    expect(postSpy).toHaveBeenCalled();
    const call = postSpy.mock.calls[0]?.[0] as { readonly body: string } | undefined;
    const body = JSON.parse(call?.body ?? "{}") as { readonly model?: string };
    expect(body.model).toBe(expectedModel);
    expect(fetchMock).not.toHaveBeenCalled();

    ws.close();
    shutdown();
    await donePromise;
  });
});
