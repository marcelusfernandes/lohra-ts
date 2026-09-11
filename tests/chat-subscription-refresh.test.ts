// Issue #351: `resolveCredentials` threw "no OAuth post configured" whenever
// the own-login token was <300s from expiring (no caller ever wired a real
// `oauthPost`), and `chat.ts`'s `catch {}` swallowed that error and fell
// through to `runChatBoundary`, which called `resolveCredentials` a SECOND
// time from scratch. On the base commit both defects together still produce
// a non-null `error` and a non-zero exit — chat-boundary's own catch already
// formats *its* attempt's failure — so the assertion that actually
// discriminates base from fixed is the number of refresh attempts: base
// makes zero POSTs (it throws before ever calling `oauthPost`), the
// swallow-only state makes two (chat.ts's attempt, discarded, then
// chat-boundary's), and the fix makes exactly one. The model/error-text
// checks pin the rest of the AC without relying on that count alone.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { enable, writeTokens } from "../src/auth/index.js";
import { runChat } from "../src/commands/chat.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "lohra-t351-chat-refresh-"));
  roots.push(value);
  return value;
}

describe("runChat surfaces a failed OAuth refresh instead of swallowing it (issue #351)", () => {
  it("returns an actionable error and a non-zero exit when the refresh POST fails", async () => {
    const base = root();
    const home = join(base, ".lohra");
    const codexHome = join(base, ".codex");
    enable(home);
    writeTokens(home, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accountId: "acct-t351-dummy",
      expiresAt: Date.now() / 1000 + 100, // <300s away: triggers the refresh branch
    });
    const fetchMock = vi.fn(() => Promise.reject(new Error("ECONNRESET")));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runChat({
      input: "oi",
      flags: new Map<string, string | true>([["--json", true]]),
      environment: {},
      home,
      codexHome,
      cwd: base,
    });

    expect(result.code).not.toBe(0);
    const envelope = JSON.parse(result.stdout) as { error: string | null; model: string | null };
    expect(envelope.error).not.toBeNull();
    expect(envelope.error).toContain("lohra auth login");
    // Discriminator: exactly one refresh attempt. Base throws before ever
    // reaching `oauthPost` (0 calls); the swallow-only intermediate state
    // discards this attempt's error and lets chat-boundary retry (2 calls).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // chat-boundary hardcodes `model: "gpt-5.5"` in its envelope; reaching
    // this codepath directly (not through the boundary) keeps it null.
    expect(envelope.model).toBeNull();
    expect(envelope.error).not.toContain("no OAuth post configured");
    expect(envelope.error).not.toContain("subscription transport is not available");
  });
});
