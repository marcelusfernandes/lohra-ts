import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

import {
  type AtomicWriteOperations,
  type OAuthPost,
  OAuthError,
  SubscriptionError,
  accountIdFromToken,
  acquireFileLease,
  atomicWrite0600,
  enable,
  isExpired,
  oauthRefreshTokens,
  pollForTokens,
  readConfig,
  readTokens,
  releaseFileLease,
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
  vi.unstubAllGlobals();
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

  it("refreshes with the real default OAuth post when no caller configures one (#351)", async () => {
    // Every production CLI entry point (chat, dashboard, chat-boundary,
    // client-pool) calls resolveCredentials without an `oauthPost` — on the
    // pre-fix code that made refresh impossible by construction, throwing
    // "no OAuth post configured" instead of ever reaching the network. This
    // pins that a real fetch-based post (the one `oauthRefreshTokens` also
    // uses for login) is wired in by default.
    const home = root();
    enable(home);
    writeTokens(home, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accountId: "acct-t351-dummy",
      expiresAt: 1_300,
    });
    const fetchMock = vi.fn((_url: string, _init: { readonly body: unknown }) =>
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

    const creds = await resolveCredentials(home, { now: 1_000, codexHome: join(home, "codex") });

    expect(creds?.token).toBe("new-access");
    expect(readTokens(home)?.refreshToken).toBe("new-refresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? ["", { body: undefined }];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(String(init.body)).toContain("grant_type=refresh_token");
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

  // issue #354: `src/auth/credentials.ts:66-67` (base) relia o token no
  // catch de falha de refresh, mas nunca coordenava duas renovações
  // concorrentes — cada `resolveCredentials` batia no `oauthPost` na sua
  // própria vez. Este teste prova a coordenação: dois refreshes ao mesmo
  // tempo, um só POST.
  it("renews under a lease so two concurrent refreshes only hit oauthPost once, issue 354", async () => {
    const home = root();
    enable(home);
    writeTokens(home, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accountId: "acct-t354-race",
      expiresAt: 1_300,
    });
    let calls = 0;
    const oauthPost: OAuthPost = () => {
      calls += 1;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve([
            200,
            { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
          ]);
        }, 20);
      });
    };
    const [a, b] = await Promise.all([
      resolveCredentials(home, { now: 1_000, codexHome: join(home, "codex"), oauthPost }),
      resolveCredentials(home, { now: 1_000, codexHome: join(home, "codex"), oauthPost }),
    ]);
    expect(calls).toBe(1);
    expect(a?.token).toBe("new-access");
    expect(b?.token).toBe("new-access");
    expect(readTokens(home)?.refreshToken).toBe("new-refresh");
  });

  // issue #354: `writeTokens` vivia dentro do `try` do POST
  // (`credentials.ts:63`) — refresh ok + escrita falhando caía no mesmo
  // `catch` que produz `RefreshFailedError`, mascarando uma falha de disco
  // como "o login falhou". Nome distinto (sem conteúdo de token na
  // mensagem) por asserção — sem importar o símbolo novo, para o commit
  // vermelho compilar contra a base.
  it("names a write failure after a successful refresh differently from RefreshFailedError, issue 354", async () => {
    const home = root();
    enable(home);
    writeTokens(home, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accountId: "acct-t354-write",
      expiresAt: 1_300,
    });
    let caught: unknown;
    try {
      await resolveCredentials(home, {
        now: 1_000,
        codexHome: join(home, "codex"),
        oauthPost: () => {
          // The lock file (`oauth.json.lock`) and the token file
          // (`oauth.json`) live in the same directory — chmod'ing `home`
          // BEFORE the call would also block acquiring the lease, never
          // reaching `writeTokens` at all. Flipping it here, inside the
          // POST, isolates the write failure: the lease is already held
          // (created while `home` was still writable) by the time this
          // runs, and the refresh response itself is fine.
          chmodSync(home, 0o500);
          return Promise.resolve([
            200,
            { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
          ]);
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      chmodSync(home, 0o700);
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.name).toBe("TokenPersistError");
    expect(error.name).not.toBe("RefreshFailedError");
    expect(error.message).not.toContain("old-access");
    expect(error.message).not.toContain("new-access");
    expect(error.message).not.toContain("new-refresh");
  });

  // Cobre a mitigação de #351 (`credentials.ts`, catch de `performRefresh`):
  // se o POST desta chamada falhar mas OUTRO processo já tiver escrito um
  // token mais novo enquanto isso, adota o que está em disco em vez de
  // lançar `RefreshFailedError` — sem essa checagem, o processo que perdeu
  // a corrida do OS (não da lease: aqui é o mesmo processo, POST simulado)
  // voltaria a um erro mesmo com um token bom já salvo.
  it("adopts a token another process already wrote when this refresh attempt itself fails", async () => {
    const home = root();
    enable(home);
    writeTokens(home, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accountId: "acct-t354-adopt",
      expiresAt: 1_300,
    });
    const creds = await resolveCredentials(home, {
      now: 1_000,
      codexHome: join(home, "codex"),
      oauthPost: () => {
        // A second process wins the race and writes fresh tokens to disk
        // right before this attempt's own POST fails.
        writeTokens(home, {
          accessToken: "other-process-access",
          refreshToken: "other-process-refresh",
          accountId: "acct-t354-adopt",
          expiresAt: 9_999,
        });
        return Promise.resolve([500, {}]);
      },
    });
    expect(creds?.token).toBe("other-process-access");
  });

  it("throws RefreshFailedError when the refresh POST fails and nothing newer was saved", async () => {
    const home = root();
    enable(home);
    writeTokens(home, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accountId: "acct-t354-genuine-failure",
      expiresAt: 1_300,
    });
    await expect(
      resolveCredentials(home, {
        now: 1_000,
        codexHome: join(home, "codex"),
        oauthPost: () => Promise.resolve([500, {}]),
      }),
    ).rejects.toMatchObject({ name: "RefreshFailedError" });
  });
});

describe("token refresh lease (#354)", () => {
  it("blocks a second holder while held, and lets a new holder steal an orphaned expired one", () => {
    const home = root();
    const lockPath = join(home, "oauth.json.lock");
    expect(acquireFileLease(lockPath, "holder-a", 10, 1_000)).toBe(true);
    // same instant, a second holder cannot acquire the still-live lease
    expect(acquireFileLease(lockPath, "holder-b", 10, 1_000)).toBe(false);
    // holder-a "dies" without releasing; once its TTL is past, a third
    // holder can steal the orphaned lease
    expect(acquireFileLease(lockPath, "holder-c", 10, 1_011)).toBe(true);
  });

  it("release is a no-op for a holder that no longer owns the lease", () => {
    const home = root();
    const lockPath = join(home, "oauth.json.lock");
    acquireFileLease(lockPath, "holder-a", 10, 1_000);
    // holder-a's lease expires and holder-b takes over before holder-a's
    // (late) release runs
    acquireFileLease(lockPath, "holder-b", 10, 1_011);
    releaseFileLease(lockPath, "holder-a");
    expect(existsSync(lockPath)).toBe(true);
    releaseFileLease(lockPath, "holder-b");
    expect(existsSync(lockPath)).toBe(false);
  });
});
