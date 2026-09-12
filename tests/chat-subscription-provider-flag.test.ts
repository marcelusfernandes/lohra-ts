// Issue #440 (dogfooding of PR #439/#426): with `auth_preference: "auto"`
// and an active Codex subscription, `--provider anthropic --model X` (or
// `--provider openrouter --model X`) used to print a note ("subscription
// mode active — ignoring --provider …") and then still send `X` to the
// Codex Responses transport, which answers with a 400
// ("model is not supported when using Codex with a ChatGPT account"). The
// failure came from the network instead of the boundary (invariant 2: fail
// with a clear cause, before any I/O that cannot help).
//
// Decision (orchestrator, 2026-09-13, option A — fail-fast): in subscription
// mode, an EXPLICIT `--provider` (with or without `--model`) now returns
// `initializationError` naming `lohra auth prefer api_key`, before
// `resolveCredentials` is ever called — no OAuth refresh POST, no Responses
// API call. `--model` alone (no `--provider`) keeps going to Codex: that is
// the legitimate "pick the subscription's model" case and must not regress.
//
// The two `it`s below discriminate base from fixed the same way
// `chat-subscription-refresh.test.ts` does: a token that is <300s from
// expiring forces the base code path through `resolveCredentials`'s refresh
// branch, which POSTs via the global `fetch` — on the base commit that POST
// happens (fetchMock called once, error mentions `lohra auth login`, not
// `lohra auth prefer api_key`); on the fix it never happens (zero calls).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { enable, writeTokens } from "../src/auth/index.js";
import { runChat } from "../src/commands/chat.js";
import { NativeChatHttpPort } from "../src/transports/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "lohra-t440-chat-provider-flag-"));
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

function envelopeOf(stdout: string): { error: string | null; model: string | null } {
  return JSON.parse(stdout) as { error: string | null; model: string | null };
}

describe("runChat refuses an explicit --provider in subscription mode before any network (issue #440)", () => {
  it.each([
    { label: "--provider alone", flags: [["--provider", "anthropic"]] as const },
    {
      label: "--provider and --model together",
      flags: [
        ["--provider", "anthropic"],
        ["--model", "claude-haiku-4-5-20251001"],
      ] as const,
    },
  ])(
    "$label: initializationError citing 'lohra auth prefer api_key', zero fetch calls",
    async ({ flags }) => {
      const { home, codexHome, base } = fixture();
      writeTokens(home, {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        accountId: "acct-t440-dummy",
        expiresAt: Date.now() / 1000 + 100, // <300s away: would trigger a refresh on the base
      });
      const fetchMock = vi.fn(() =>
        Promise.reject(new Error("t440: no network call is allowed for this route")),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await runChat({
        input: "oi",
        flags: new Map<string, string | true>([...flags, ["--json", true]]),
        environment: {},
        home,
        codexHome,
        cwd: base,
      });

      expect(result.code).not.toBe(0);
      const envelope = envelopeOf(result.stdout);
      expect(envelope.model).toBeNull();
      expect(envelope.error).not.toBeNull();
      expect(envelope.error).toContain("--provider anthropic");
      expect(envelope.error).toContain("lohra auth prefer api_key");
      expect(result.stderr).toContain("lohra auth prefer api_key");
      // Discriminator: on the base, the near-expiring token above sends this
      // through resolveCredentials's refresh branch, which POSTs via `fetch`.
      // The fix never gets there.
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("runChat still routes --model alone (no --provider) to Codex in subscription mode (non-regression)", () => {
  it("does not return the --provider refusal and reaches the Responses transport", async () => {
    const { home, codexHome, base } = fixture();
    writeTokens(home, {
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      accountId: "acct-t440-nonregression",
      expiresAt: Date.now() / 1000 + 999_999, // far from expiring: no refresh POST either way
    });
    // The Responses client talks straight to `chatgpt.com` over Node's
    // https module (no injectable fetcher wired by `chat.ts`), so the only
    // safe way to keep this test off the real network is to intercept the
    // shared HTTP port itself, not `global.fetch`.
    const postSpy = vi
      .spyOn(NativeChatHttpPort.prototype, "post")
      .mockRejectedValue(new Error("t440: no real network call in tests"));

    const result = await runChat({
      input: "oi",
      flags: new Map<string, string | true>([
        ["--model", "gpt-5.5-codex-t440"],
        ["--json", true],
        ["--no-tools", true],
      ]),
      environment: { HOME: base },
      home,
      codexHome,
      cwd: base,
    });

    expect(result.code).not.toBe(0);
    const envelope = envelopeOf(result.stdout);
    // The model chosen via --model actually reached the runtime — the
    // outer catch in chat.ts always echoes the outer-scope `model` it was
    // building the request with, so this pins that --model still flows to
    // the Codex/Responses route in this case.
    expect(envelope.model).toBe("gpt-5.5-codex-t440");
    expect(envelope.error).not.toBeNull();
    expect(envelope.error).not.toContain("lohra auth prefer api_key");
    expect(envelope.error).not.toContain("ignoring --provider");
    // Proves this actually reached the transport instead of being refused
    // at the boundary like the describe block above.
    expect(postSpy).toHaveBeenCalled();
  });
});
