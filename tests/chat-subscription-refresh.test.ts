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

// Issue #357: lets `writeTokens` fail on demand without touching real
// filesystem permission bits. A chmod-based simulation was tried first and
// rejected: the refresh lease file (`credentials.ts`) lives in the same
// directory as the token file, so making that directory unwritable also
// blocks the lease's own release/reacquire and masks the actual double-POST
// bug behind an unrelated ~10s lease-contention wait. `active` starts
// `false` so the initial-token setup call below goes through untouched.
const writeFailure = vi.hoisted(() => ({ active: false }));
vi.mock("../src/auth/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/store.js")>();
  return {
    ...actual,
    writeTokens: (...args: Parameters<typeof actual.writeTokens>) => {
      if (writeFailure.active) throw new Error("EROFS: read-only file system, open");
      actual.writeTokens(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  writeFailure.active = false;
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

// Issue #357: `chat.ts:~178` only intercepted `RefreshFailedError`. A
// `TokenPersistError` (issue #354: the refresh POST itself succeeded, only
// the disk write failed) fell through to `runChatBoundary`, which called
// `resolveCredentials` a SECOND time from scratch — reading the OLD token
// still on disk (the write never landed) and retrying the refresh with a
// refresh_token the provider already rotated on the first, successful,
// attempt. As with #351, the number of `oauthPost` attempts is the
// assertion that discriminates base from fixed: base makes two POSTs (this
// attempt's success, discarded, then chat-boundary's retry, whose own write
// also fails since `writeFailure.active` stays on), the fix makes exactly
// one.
describe("runChat treats a successful refresh whose disk write fails as terminal (issue #357)", () => {
  it("returns an actionable error, a non-zero exit, and exactly one refresh POST", async () => {
    const base = root();
    const home = join(base, ".lohra");
    const codexHome = join(base, ".codex");
    enable(home);
    writeTokens(home, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accountId: "acct-t357-dummy",
      expiresAt: Date.now() / 1000 + 100, // <300s away: triggers the refresh branch
    });
    writeFailure.active = true;
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
      }),
    );
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
    // Discriminator: exactly one refresh attempt (see comment above).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // chat-boundary hardcodes `model: "gpt-5.5"` in its envelope; reaching
    // this codepath directly (not through the boundary) keeps it null.
    expect(envelope.model).toBeNull();
    expect(envelope.error).toContain("check permissions/disk space");
    // chat-boundary's own catch prefixes with "subscription mode: " —
    // absence of that prefix confirms this went through the direct
    // interception, not a second round-trip through the boundary.
    expect(envelope.error).not.toContain("subscription mode:");
    // Never leak either token value into the surfaced message.
    expect(envelope.error).not.toContain("new-access");
    expect(envelope.error).not.toContain("new-refresh");
    expect(envelope.error).not.toContain("old-access");
    expect(envelope.error).not.toContain("old-refresh");
  });
});
