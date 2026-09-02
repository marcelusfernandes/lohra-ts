import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import {
  type AtomicWriteOperations,
  OAuthError,
  SubscriptionError,
  accountIdFromToken,
  atomicWrite0600,
  enable,
  isExpired,
  oauthRefreshTokens,
  pollForTokens,
  readConfig,
  readTokens,
  resolveCredentials,
  routeFor,
  setPreference,
  startDeviceLogin,
  status,
  writeConfig,
  writeTokens,
} from "../src/auth/index.js";

const roots: string[] = [];
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "lohra-auth-test-"));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const jwt = (payload: object): string => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `x.${encoded}.x`;
};

describe("auth stores", () => {
  const recordingOperations = (
    failures: ReadonlySet<string> = new Set(),
  ): { readonly events: string[]; readonly operations: AtomicWriteOperations } => {
    const events: string[] = [];
    const fail = (operation: string): void => {
      events.push(operation);
      if (failures.has(operation)) throw new Error(`injected ${operation} failure`);
    };
    return {
      events,
      operations: {
        mkdir: () => {
          fail("mkdir");
        },
        open: (_path, flags, mode) => {
          fail(`open:${flags}:${mode.toString(8)}`);
          return 17;
        },
        write: (_descriptor, bytes, offset) => {
          fail("write");
          return bytes.length - offset;
        },
        fsync: () => {
          fail("fsync");
        },
        close: () => {
          fail("close");
        },
        rename: () => {
          fail("rename");
        },
        unlink: () => {
          fail("unlink");
        },
        pid: 11,
        now: () => 22,
      },
    };
  };

  it("orders the safe-write seam and fails closed before replacement", () => {
    const success = recordingOperations();
    atomicWrite0600("/tmp/auth.json", "{}", success.operations);
    expect(success.events).toEqual(["mkdir", "open:wx:600", "write", "fsync", "close", "rename"]);

    const truncated = recordingOperations(new Set(["write"]));
    expect(() => {
      atomicWrite0600("/tmp/auth.json", "{}", truncated.operations);
    }).toThrow("injected write failure");
    expect(truncated.events).toEqual(["mkdir", "open:wx:600", "write", "close", "unlink"]);

    const rename = recordingOperations(new Set(["rename"]));
    expect(() => {
      atomicWrite0600("/tmp/auth.json", "{}", rename.operations);
    }).toThrow("injected rename failure");
    expect(rename.events).toEqual([
      "mkdir",
      "open:wx:600",
      "write",
      "fsync",
      "close",
      "rename",
      "unlink",
    ]);
  });

  it("fails closed and preserves unknown fields while writing mode 0600", () => {
    const home = root();
    expect(readConfig(home)).toBeNull();
    writeFileSync(
      join(home, "auth.json"),
      '{"neighbor":{"x":1},"openai":{"future":"keep","preference":"api_key"}}',
    );
    writeConfig(home, {
      authMode: "subscription",
      acknowledgedTosRisk: true,
      preference: "auto",
    });
    expect(readConfig(home)).toEqual({
      authMode: "subscription",
      acknowledgedTosRisk: true,
      preference: "auto",
    });
    const raw = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(raw.neighbor).toEqual({ x: 1 });
    expect(raw.openai?.future).toBe("keep");
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
  });

  it("keeps mode and active independent and preference case-sensitive", () => {
    const home = root();
    writeFileSync(
      join(home, "auth.json"),
      '{"openai":{"auth_mode":"subscription","acknowledged_tos_risk":"true","preference":"AUTO"}}',
    );
    expect(readConfig(home)).toEqual({
      authMode: "subscription",
      acknowledgedTosRisk: false,
      preference: "auto",
    });
    expect(status(home, { codexHome: join(home, "codex"), now: 1 })).toMatchObject({
      mode: "subscription",
      active: false,
      preference: "auto",
    });
  });

  it("writes and reads oauth tokens atomically at mode 0600", () => {
    const home = root();
    writeTokens(home, {
      accessToken: "access-dummy",
      refreshToken: "refresh-dummy",
      accountId: "acct-t05-dummy",
      expiresAt: 123,
    });
    expect(readTokens(home)).toMatchObject({ accessToken: "access-dummy", expiresAt: 123 });
    expect(statSync(join(home, "oauth.json")).mode & 0o777).toBe(0o600);
  });
});

describe("routing and expiry", () => {
  it("implements the complete route truth table", () => {
    expect(routeFor("auto", true).mode).toBe("subscription");
    expect(routeFor("auto", false).mode).toBe("api_key");
    expect(routeFor("api_key", true).note).toContain("preference=api_key");
    expect(routeFor("api_key", false)).toEqual({ mode: "api_key" });
    expect(routeFor("subscription", true)).toEqual({ mode: "subscription" });
    expect(routeFor("subscription", false).error).toContain("preference=subscription");
    expect(routeFor("typo", true).mode).toBe("subscription");
    expect(routeFor("typo", false).mode).toBe("api_key");
  });

  it("treats exactly now plus 300 as expired", () => {
    expect(isExpired(jwt({ exp: 1_300 }), 1_000)).toBe(true);
    expect(isExpired(jwt({ exp: 1_301 }), 1_000)).toBe(false);
    expect(isExpired("garbage", 1_000)).toBe(true);
  });

  it("extracts account ids in precedence order", () => {
    expect(accountIdFromToken(jwt({ chatgpt_account_id: "top" }))).toBe("top");
    expect(
      accountIdFromToken(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "nested" } })),
    ).toBe("nested");
    expect(accountIdFromToken(jwt({ organizations: [{ id: "org" }] }))).toBe("org");
  });
});

describe("oauth and credentials", () => {
  it("keeps the two post seams explicit and refresh rotation", async () => {
    const device = await startDeviceLogin(() =>
      Promise.resolve([200, { device_auth_id: "D", user_code: "WXYZ", interval: 0 }]),
    );
    expect(device.interval).toBe(5);
    const calls: string[] = [];
    const tokens = await pollForTokens(
      device,
      (url) => {
        calls.push(url);
        return Promise.resolve(
          calls.length === 1
            ? [403, {}]
            : calls.length === 2
              ? [200, { authorization_code: "C", code_verifier: "V" }]
              : [
                  200,
                  {
                    access_token: jwt({ chatgpt_account_id: "acct" }),
                    refresh_token: "R",
                  },
                ],
        );
      },
      {
        sleep: () => Promise.resolve(),
        monotonicNow: (() => {
          let n = 0;
          return () => n++;
        })(),
      },
    );
    expect(tokens.refreshToken).toBe("R");
    const refreshed = await oauthRefreshTokens("R", () =>
      Promise.resolve([200, { access_token: "A" }]),
    );
    expect(refreshed.refreshToken).toBe("R");
  });

  it("refreshes at the boundary and persists rotated tokens", async () => {
    const home = root();
    enable(home);
    writeTokens(home, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accountId: "acct-t05-dummy",
      expiresAt: 1_300,
    });
    const creds = await resolveCredentials(home, {
      now: 1_000,
      codexHome: join(home, "codex"),
      oauthPost: () =>
        Promise.resolve([
          200,
          { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
        ]),
    });
    expect(creds?.token).toBe("new-access");
    expect(readTokens(home)?.refreshToken).toBe("new-refresh");
  });

  it("fails token-free when subscription is unusable", async () => {
    const home = root();
    enable(home);
    await expect(
      resolveCredentials(home, { now: 1_000, codexHome: join(home, "codex") }),
    ).rejects.toBeInstanceOf(SubscriptionError);
    expect(() => {
      setPreference(home, "bogus");
    }).toThrow("unknown auth preference 'bogus'");
    await expect(startDeviceLogin(() => Promise.resolve([500, {}]))).rejects.toBeInstanceOf(
      OAuthError,
    );
  });
});
